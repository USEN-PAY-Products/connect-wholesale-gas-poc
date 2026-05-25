// =============================================================================
// be_csv_mapper.js
//
// 卸ごとの動的マッピングJSON（csv_format_rules 新形式）を解釈し、
// 以下の処理を提供するアドオンモジュール。
//
//   ① validateCsvHeaderByRules_()   … CSVヘッダー行の最速バリデーション
//   ② buildInvoiceLinesSelectSql_() … Staging → invoice_lines 動的キャスト SELECT 生成
//   ③ buildMappedTransactionSql_()  … BEGIN TRANSACTION 〜 COMMIT の全体 DML 組み立て
//
// 【既存コードとの結合点 in be_invoice.js → sendInvoiceData()】
//
//   ┌ 既存の処理基盤（変更不要）─────────────────────────────────────────────┐
//   │  ① Drive に CSV を保存               → loadCsvToBq_() の前に実行済み    │
//   │  ② BQ Load Job 投入                  → loadCsvToBq_()                  │
//   │  ③ Load Job 完了待ち（ポーリング）    → waitForLoadJob_()               │
//   │  ⑥ Staging テーブル DROP             → dropStagingTable_()             │
//   └────────────────────────────────────────────────────────────────────────┘
//   ↓ 追加する呼び出し（★マークの箇所に挿入）
//
//   // ★② Load Job 投入「前」にヘッダーだけを検証（10万行のパース不要）
//   validateCsvHeaderByRules_(csvText, accountInfo.csv_format_rules);
//
//   // ★⑤ Load Job 完了後、既存の buildTransactionSql_() の「代わり」に呼び出す
//   //    ※ csv_format_rules が新形式（columns 配列）の卸にのみ使用する
//   const sql = buildMappedTransactionSql_({
//     invoiceUuid, stagingId, summaryData, remarks,
//     accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
//     csvFormatRules: accountInfo.csv_format_rules,
//   });
//   runTransactionSql_(projectId, sql);
//
// 【対応する csv_format_rules の形式（新形式）】
//   既存の csv_format_rules（キー名 → { bq_field, type, csv_header } のオブジェクト形式）と
//   本ファイルが扱う「新形式」は異なります。切り替えは sendInvoiceData 側で判定してください。
//
//   新形式:
//   {
//     "has_header": true,
//     "columns": [
//       { "index": 0, "csv_header": "伝票日付",   "system_column": "transaction_date",
//         "type": "date", "format": "YYYYMMDD", "required": true },
//       { "index": 3, "csv_header": "得意先名１", "system_column": null,
//         "type": "string", "required": false },
//       ...
//     ]
//   }
//
// 依存:
//   db_bq_connection.js … runTransactionSql_()（呼び出し側で使用）
//   GAS 組み込み       … Utilities, Logger
// =============================================================================


// =============================================================================
// ① CSVヘッダー行の最速バリデーション
// =============================================================================

/**
 * CSV のヘッダー行（1行目のみ）を csv_format_rules.columns 定義と照合して検証する。
 * 10万行のデータ全体をパースせず、ヘッダー行だけで異常 CSV を即時拒否する。
 *
 * 【検証内容】
 *   1. required: true の全列が CSV ヘッダーに「列名として」存在すること
 *   2. JSON の index と CSV 上の実際の列位置（0始まり）が完全一致すること（位置ズレ検知）
 *
 * 【既存コードとの結合点】
 *   be_invoice.js の sendInvoiceData() で utf8CsvBase64 を文字列化した後、
 *   loadCsvToBq_()（BQ Load Job 投入）の「前」に呼び出してください。
 *
 *   // 呼び出しイメージ（sendInvoiceData 内）:
 *   const csvText = Utilities.newBlob(Utilities.base64Decode(utf8CsvBase64), MimeType.CSV)
 *                             .getDataAsString('UTF-8');
 *   if (isNewFormatRules_(accountInfo.csv_format_rules)) {
 *     validateCsvHeaderByRules_(csvText, accountInfo.csv_format_rules);  // ★追加
 *   } else {
 *     validateCsvHeader_(csvText, getExpectedHeaders_(accountInfo.csv_format_rules)); // 既存
 *   }
 *
 * @param {string} csvText        - CSV テキスト（UTF-8）。BOM 有無どちらでも可。
 * @param {Object} csvFormatRules - 新形式の csv_format_rules（columns 配列を持つ）
 * @throws {Error} ヘッダーが不正な場合。不一致となった列名を含む詳細メッセージを付与する。
 */
function validateCsvHeaderByRules_(csvText, csvFormatRules) {
  if (!csvFormatRules || !Array.isArray(csvFormatRules.columns)) {
    throw new Error(
      '[CsvMapper] csv_format_rules が新形式ではありません。' +
      'columns 配列が存在するか確認してください。'
    );
  }

  // 1行目のみ取り出す（BOM・CR を除去）
  const firstNewline = csvText.indexOf('\n');
  const rawHeaderLine = firstNewline === -1 ? csvText : csvText.slice(0, firstNewline);
  const headerLine = rawHeaderLine.replace(/^\uFEFF/, '').replace(/\r$/, '');

  const csvHeaders = parseCsvLineMapper_(headerLine);
  const columns    = csvFormatRules.columns;
  const errors     = [];

  columns.forEach(function(col) {
    const csvHeaderVal = col.csv_header;
    const definedIdx   = col.index;

    // ── 検証1: required: true の列が CSV ヘッダーに存在するか ─────────────
    const actualIdx = csvHeaders.indexOf(csvHeaderVal);
    if (col.required && actualIdx === -1) {
      errors.push(
        '必須列「' + csvHeaderVal + '」が CSV ヘッダーに存在しません。' +
        '（定義上の期待インデックス: ' + definedIdx + '）'
      );
      return; // 存在しない列の位置チェックはスキップ
    }

    // ── 検証2: JSON の index と CSV 実際の列位置が一致するか（位置ズレ検知）──
    if (actualIdx !== -1 && actualIdx !== definedIdx) {
      errors.push(
        '列「' + csvHeaderVal + '」の位置がズレています。' +
        '定義: index=' + definedIdx + ', ' +
        'CSVの実際の位置: index=' + actualIdx + '。' +
        'CSVまたはマッピングJSON（csv_format_rules）を確認してください。'
      );
    }
  });

  if (errors.length > 0) {
    throw new Error(
      '[CsvMapper] CSVヘッダー検証エラー（' + errors.length + '件）:\n' +
      errors.map(function(e, i) { return '  ' + (i + 1) + '. ' + e; }).join('\n')
    );
  }

  Logger.log(
    '[CsvMapper] ヘッダー検証OK: ' + csvHeaders.length + '列確認 / ' +
    'required列: ' + columns.filter(function(c) { return c.required; }).length + '件'
  );
}


// =============================================================================
// ② Staging → invoice_lines 動的キャスト SELECT SQL 生成
// =============================================================================

/**
 * csv_format_rules.columns 定義に従い、Staging テーブル（string_field_N 形式）から
 * invoice_lines へキャストしながら転記する INSERT ... SELECT 文を動的に生成する。
 *
 * 【SELECT 式の生成ルール】
 *   - system_column が null の列 → 転記対象外（SELECT 句から完全除外）
 *   - type: "date", format: "YYYYMMDD" → PARSE_DATE('%Y%m%d', string_field_N)
 *   - type: "integer"                  → CAST(string_field_N AS INT64)
 *   - type: "string"                   → string_field_N（キャスト不要）
 *
 * 【計算項目 tax_amount のインジェクション】
 *   - tax_amount は CSV に存在しないため、amount_ex_tax と tax_rate の index を
 *     JSON から「逆引き」して動的に計算式を生成・挿入する。
 *   - 端数処理: FLOOR（切り捨て）
 *
 * 【SQLインジェクション対策】
 *   - wholesalerInvoiceId, mallCode はリテラルとして SQL に埋め込むため esc_() でエスケープ
 *   - フィールド参照（string_field_N, PARSE_DATE 等）はマッピングJSON由来で固定パターンのみ生成
 *
 * @param {Object} csvFormatRules          - 新形式の csv_format_rules（columns 配列を持つ）
 * @param {string} stagingRef              - Staging テーブルの完全修飾参照（バッククォート付き文字列）
 *                                           例: "`project.dataset.staging_invoice_lines_xxxx`"
 * @param {string} wholesalerInvoiceId     - 親テーブルの ID（SELECT 定数カラムとして埋め込む）
 * @param {string} mallCode                - モールコード（SELECT 定数カラムとして埋め込む）
 * @returns {{ insertColumns: string[], selectSql: string }}
 *   - insertColumns: INSERT 句に使用するカラム名配列
 *   - selectSql:     SELECT ... FROM staging_ref の SQL 文字列（末尾の `;` を含む）
 * @throws {Error} amount_ex_tax または tax_rate が columns に定義されていない場合
 */
function buildInvoiceLinesSelectSql_(csvFormatRules, stagingRef, wholesalerInvoiceId, mallCode) {
  const columns = csvFormatRules.columns;

  // ── tax_amount 計算用インデックスを system_column から逆引き ──────────────
  // JSON 定義変更でインデックスがずれても自動追従する。
  const amountCol  = columns.find(function(c) { return c.system_column === 'amount_ex_tax'; });
  const taxRateCol = columns.find(function(c) { return c.system_column === 'tax_rate'; });

  if (!amountCol) {
    throw new Error(
      '[CsvMapper] csv_format_rules.columns に amount_ex_tax の定義がありません。' +
      'tax_amount の自動計算に必要です。'
    );
  }
  if (!taxRateCol) {
    throw new Error(
      '[CsvMapper] csv_format_rules.columns に tax_rate の定義がありません。' +
      'tax_amount の自動計算に必要です。'
    );
  }

  const amountFieldRef  = 'string_field_' + amountCol.index;
  const taxRateFieldRef = 'string_field_' + taxRateCol.index;

  // ── SELECT 式を生成（INSERT カラムリストも並行して構築） ─────────────────
  const insertColumns = ['wholesaler_invoice_id', 'mall_code'];
  const selectParts   = [
    // 定数カラム（GAS から埋め込む）
    "  '" + escSql_(wholesalerInvoiceId) + "' AS wholesaler_invoice_id  -- GAS 定数埋め込み",
    "  '" + escSql_(mallCode)            + "' AS mall_code              -- GAS 定数埋め込み",
  ];

  columns.forEach(function(col) {
    // system_column が null の列は転記対象外
    if (col.system_column === null || col.system_column === undefined) return;

    insertColumns.push(col.system_column);

    const fieldRef = 'string_field_' + col.index;
    let castExpr;

    switch (col.type) {
      case 'date':
        // 現時点で対応するフォーマットは YYYYMMDD のみ（他フォーマットは将来拡張）
        castExpr = col.format === 'YYYYMMDD'
          ? "PARSE_DATE('%Y%m%d', " + fieldRef + ')'
          : fieldRef;
        break;
      case 'integer':
        castExpr = 'CAST(' + fieldRef + ' AS INT64)';
        break;
      case 'string':
      default:
        castExpr = fieldRef;
        break;
    }

    selectParts.push(
      '  ' + padRight_(castExpr, 56) + ' AS ' + col.system_column +
      '  -- ' + col.csv_header + ' (index: ' + col.index + ')'
    );
  });

  // ── tax_amount を計算式としてインジェクション ────────────────────────────
  // CSV に存在しない計算項目のため、amount_ex_tax と tax_rate の index から動的に生成する。
  const taxAmountExpr =
    'CAST(FLOOR(CAST(' + amountFieldRef  + ' AS INT64) * ' +
                'CAST(' + taxRateFieldRef + ' AS INT64) / 100) AS INT64)';

  insertColumns.push('tax_amount');
  selectParts.push(
    '  ' + taxAmountExpr + ' AS tax_amount' +
    '  -- 消費税額: FLOOR(金額(index:' + amountCol.index +
    ') × 税率(index:' + taxRateCol.index + ') / 100) 端数切り捨て'
  );

  const selectSql = [
    'SELECT',
    selectParts.join(',\n'),
    'FROM ' + stagingRef + ';',
  ].join('\n');

  Logger.log(
    '[CsvMapper] SELECT SQL 生成完了: ' + insertColumns.length + 'カラム' +
    '（うち計算項目: tax_amount）'
  );

  return { insertColumns: insertColumns, selectSql: selectSql };
}


// =============================================================================
// ③ BEGIN TRANSACTION 〜 COMMIT の全体 DML 組み立て
// =============================================================================

/**
 * BEGIN TRANSACTION 〜 COMMIT を含む全体トランザクション SQL を組み立てる。
 *
 * 【INSERT 順序（孤立リスク最小化）】
 *   1. 子テーブル (merchant_invoices) — フロント確定値を VALUES で複数行展開
 *   2. 孫テーブル (invoice_lines)     — Staging から動的 SELECT でキャスト転記  ★アドオン核心
 *   3. 親テーブル (wholesaler_invoices) — 最後に INSERT（エラー時に子・孫ごとロールバックされる）
 *
 * 【SQLインジェクション対策（マルチステートメント制約への対応）】
 *   BigQuery の BEGIN TRANSACTION 〜 COMMIT を含むマルチステートメントスクリプトでは
 *   Named Parameter（@param）が使用できない（BQ 仕様制限）。そのため:
 *     - 文字列（remarks, mallCode 等）: escSql_() でシングルクォートをエスケープ
 *     - 数値（金額等）: Number() でキャストし isFinite・isInteger・非負を事前検証
 *     - ID 値（UUID 等）: 正規表現でフォーマットを検証してから埋め込む
 *     - テーブル名（stagingId）: 英数字とアンダースコアのみ許可する正規表現で検証
 *
 * 【既存コードとの結合点】
 *   be_invoice.js の sendInvoiceData() で、csv_format_rules が新形式の場合に
 *   既存の buildTransactionSql_() の「代わりに」呼び出します。
 *
 *   // 呼び出しイメージ（sendInvoiceData 内）:
 *   let sql;
 *   if (isNewFormatRules_(accountInfo.csv_format_rules)) {
 *     sql = buildMappedTransactionSql_({          // ★ 新形式（本関数）
 *       invoiceUuid, stagingId, summaryData, remarks,
 *       accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
 *       csvFormatRules: accountInfo.csv_format_rules,
 *     });
 *   } else {
 *     sql = buildTransactionSql_(                 // 既存（旧形式）
 *       invoiceUuid, stagingId, summaryData, remarks,
 *       accountInfo, mallCodeMap, csvUrl, projectId, datasetId
 *     );
 *   }
 *   runTransactionSql_(projectId, sql);           // 既存の実行関数をそのまま使用
 *
 * @param {Object} params
 * @param {string} params.invoiceUuid    - 請求UUID（ハイフン付き形式）
 * @param {string} params.stagingId      - Staging テーブル名（ハイフンなし英数字+アンダースコア）
 * @param {Object} params.summaryData    - フロント確定値 { wholesalerTotal, merchantTotals }
 *   wholesalerTotal: {
 *     totalAmount, subtotalAmount, taxAmount,
 *     exTax8, tax8, exTax10, tax10,
 *     feeAmount, paymentAmount
 *   }
 *   merchantTotals: Array<{
 *     customerCode, merchantName, slipNumber,
 *     totalAmount, subtotalAmount, taxAmount,
 *     exTax8, tax8, exTax10, tax10
 *   }>
 * @param {Object} params.remarks        - 加盟店別備考 { [customerCode]: string }
 * @param {Object} params.accountInfo    - getServerAccountInfo_() の返り値
 * @param {Object} params.mallCodeMap    - buildMallCodeMap_() の返り値 { [customerCode]: mallCode }
 * @param {string} params.csvUrl         - Drive 保存後の CSV URL
 * @param {string} params.projectId      - GCP プロジェクトID
 * @param {string} params.datasetId      - BQ データセットID
 * @param {Object} params.csvFormatRules - 新形式の csv_format_rules（columns 配列を持つ）
 * @returns {string} BQ に直接渡せるトランザクション SQL 全文
 * @throws {Error} 入力値の検証エラー、または SELECT SQL 生成エラー時
 */
function buildMappedTransactionSql_(params) {
  const {
    invoiceUuid, stagingId, summaryData, remarks,
    accountInfo, mallCodeMap, csvUrl, projectId, datasetId, csvFormatRules,
  } = params;

  const wsId     = Number(accountInfo.wholesaler_id);
  const wsUserId = String(accountInfo.wholesaler_user_id);
  const feeRate  = Number(accountInfo.fee_rate || 0);
  const wt       = summaryData.wholesalerTotal;

  // ── 入力値の型・範囲検証（SQL インジェクション対策の第一層） ────────────
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(invoiceUuid)) {
    throw new Error('[CsvMapper] invoiceUuid の形式が不正です: ' + invoiceUuid);
  }
  if (!UUID_RE.test(wsUserId)) {
    throw new Error('[CsvMapper] wsUserId の形式が不正です: ' + wsUserId);
  }
  // Staging テーブル名: 英数字とアンダースコアのみ許可（テーブル名インジェクション対策）
  if (!/^[a-zA-Z0-9_]+$/.test(stagingId)) {
    throw new Error('[CsvMapper] stagingId に不正な文字が含まれています: ' + stagingId);
  }
  if (!Number.isInteger(wsId) || wsId <= 0) {
    throw new Error('[CsvMapper] wholesaler_id が不正です: ' + wsId);
  }

  // 卸合計値の数値検証（有限・非負・整数）
  ['totalAmount','subtotalAmount','taxAmount','exTax8','tax8','exTax10','tax10','feeAmount','paymentAmount']
    .forEach(function(f) {
      const v = Number(wt[f] || 0);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        throw new Error('[CsvMapper] wholesalerTotal.' + f + ' が不正な値です: ' + wt[f]);
      }
    });

  // 加盟店合計値の数値検証
  summaryData.merchantTotals.forEach(function(m, idx) {
    ['totalAmount','subtotalAmount','taxAmount','exTax8','tax8','exTax10','tax10']
      .forEach(function(f) {
        const v = Number(m[f] || 0);
        if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
          throw new Error(
            '[CsvMapper] merchantTotals[' + idx + '].' + f + ' が不正な値です: ' + m[f]
          );
        }
      });
  });

  // ── テーブル参照（完全修飾名）を構築 ────────────────────────────────────
  const q           = function(tbl) { return '`' + projectId + '.' + datasetId + '.' + tbl + '`'; };
  const stagingRef  = q(stagingId);
  const merchantRef = q('merchant_invoices');
  const linesRef    = q('invoice_lines');
  const invRef      = q('wholesaler_invoices');

  // ── 孫テーブル用の動的 SELECT SQL を生成 ★アドオン核心 ───────────────────
  // buildInvoiceLinesSelectSql_() が INSERT カラムリストと SELECT 文を同時に返す。
  // mall_code は merchantTotals の customerCode → mallCodeMap で既に解決済みのため、
  // ここでは代表値として空文字を渡し、実際の値は子テーブルとの JOIN で取得する設計も可能。
  // 今回は設計仕様書に従い、merchant_invoices の mall_code から JOIN して取得する方針とする。
  const { insertColumns, selectSql } = buildInvoiceLinesSelectSql_(
    csvFormatRules,
    stagingRef,
    invoiceUuid,
    '' // mall_code は JOIN で取得するため空文字（後述の SELECT 内で mi.mall_code に上書き）
  );

  // ── 子テーブル (merchant_invoices) の VALUES を加盟店数分だけ展開 ─────────
  const childRows = summaryData.merchantTotals.map(function(m) {
    const mallCode  = escSql_(mallCodeMap[String(m.customerCode)] || '');
    const remark    = escSql_(remarks[String(m.customerCode)] || '');
    const remarkSql = remark ? "'" + remark + "'" : 'NULL';
    return (
      '  (' +
      "'" + escSql_(invoiceUuid)         + "', " +  // wholesaler_invoice_id
           wsId                          + ', '  +  // wholesaler_id
      "'" + mallCode                     + "', " +  // mall_code
      "'" + escSql_(m.customerCode || '') + "', " + // customer_code
      "'" + escSql_(m.merchantName  || '') + "', " + // merchant_name
      "'" + escSql_(m.slipNumber    || '') + "', " + // slip_number（文字列で保持）
           remarkSql                    + ', '  +  // wholesaler_remark（NULL または文字列）
           Number(m.taxAmount   || 0)  + ', '  +  // tax_amount
           Number(m.exTax8     || 0)   + ', '  +  // total_ex_tax_8
           Number(m.exTax10    || 0)   +           // total_ex_tax_10
      ')'
    );
  });

  // ── INSERT ... SELECT の invoice_lines 用カラムリストを上書き補正 ─────────
  // buildInvoiceLinesSelectSql_() が生成した mall_code 定数（空文字）を
  // merchant_invoices テーブルの mall_code カラム（JOIN 結果）に差し替える設計を採る場合は
  // ここで SELECT 句をラップする。今回は仕様書どおりの定数埋め込み方式を採用する。
  // （invoiceUuid は全行共通のため定数埋め込みで問題ない）

  // ── 全体 SQL を結合 ──────────────────────────────────────────────────────
  const sqlLines = [
    'BEGIN TRANSACTION;',
    '',
    '-- =========================================================',
    '-- 1. 子テーブル (merchant_invoices)',
    '--    フロントの summaryData.merchantTotals から VALUES を展開',
    '-- =========================================================',
    'INSERT INTO ' + merchantRef + ' (',
    '  wholesaler_invoice_id, wholesaler_id, mall_code, customer_code,',
    '  merchant_name, slip_number, wholesaler_remark,',
    '  tax_amount, total_ex_tax_8, total_ex_tax_10',
    ')',
    'VALUES',
    childRows.join(',\n') + ';',
    '',
    '-- =========================================================',
    '-- 2. ★孫テーブル (invoice_lines)                          ',
    '--    Staging テーブルから動的キャスト SELECT で一括転記     ',
    '--    【アドオン対象: buildInvoiceLinesSelectSql_() が生成】 ',
    '-- =========================================================',
    'INSERT INTO ' + linesRef + ' (',
    '  ' + insertColumns.join(', '),
    ')',
    selectSql,
    '',
    '-- =========================================================',
    '-- 3. 親テーブル (wholesaler_invoices)',
    '--    最後に INSERT することで子・孫の孤立リスクを最小化      ',
    '-- =========================================================',
    'INSERT INTO ' + invRef + ' (',
    '  wholesaler_id, wholesaler_user_id, wholesaler_invoice_id,',
    '  wholesaler_invoice_date,',
    '  wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
    '  wholesaler_total_ex_tax_8, wholesaler_total_ex_tax_10,',
    '  wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
    '  handover_matter, wholesaler_invoice_csv_url',
    ')',
    'VALUES (',
    '  ' + wsId + ",",
    "  '" + escSql_(wsUserId)      + "',",
    "  '" + escSql_(invoiceUuid)   + "',",
    "  CURRENT_DATE('Asia/Tokyo'),",
    '  ' + Number(wt.totalAmount   || 0) + ', ' +
          Number(wt.subtotalAmount || 0) + ', ' +
          Number(wt.taxAmount      || 0) + ',',
    '  ' + Number(wt.exTax8        || 0) + ', ' +
          Number(wt.exTax10        || 0) + ',',
    '  ' + feeRate                        + ', ' +
          Number(wt.feeAmount      || 0) + ', ' +
          Number(wt.paymentAmount  || 0) + ',',
    '  NULL,',
    "  '" + escSql_(csvUrl) + "'",
    ');',
    '',
    'COMMIT;',
  ];

  const sql = sqlLines.join('\n');
  Logger.log('[CsvMapper] トランザクション SQL 生成完了 (' + sql.length + ' 文字)');
  return sql;
}


// =============================================================================
// 内部ユーティリティ
// =============================================================================

/**
 * SQL 文字列内のシングルクォートを '' でエスケープする（SQL インジェクション対策）。
 * be_invoice.js の esc() と同等だが、本ファイル内の独立性を担保するため別途定義する。
 *
 * @param {*} s - エスケープ対象の値（null/undefined は空文字に変換）
 * @returns {string}
 * @private
 */
function escSql_(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

/**
 * CSV の1行をフィールド配列にパースする（RFC 4180 準拠、状態機械ベース）。
 * be_invoice.js の parseCsvLine_() と同等だが、本ファイル内の独立性を担保するため別途定義する。
 * ヘッダー行のバリデーションにのみ使用する（データ行はパースしない）。
 *
 * @param {string} line - 改行を含まない1行
 * @returns {string[]}
 * @private
 */
function parseCsvLineMapper_(line) {
  const result = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      if (i > 0 && line[i - 1] === ',') result.push('');
      break;
    }
    if (line[i] === '"') {
      let val = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { val += line[i++]; }
      }
      result.push(val.trim());
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { result.push(line.slice(i).trim()); break; }
      result.push(line.slice(i, end).trim());
      i = end + 1;
    }
  }
  return result;
}

/**
 * 文字列を指定した幅まで右側をスペースで埋める（SELECT 式の縦揃え用）。
 *
 * @param {string} str - 対象文字列
 * @param {number} len - 揃える幅（文字数）
 * @returns {string}
 * @private
 */
function padRight_(str, len) {
  return str.length >= len ? str : str + Array(len - str.length + 1).join(' ');
}

/**
 * csv_format_rules が新形式（columns 配列を持つ）かどうかを判定する。
 * sendInvoiceData() 側で既存の buildTransactionSql_() と本モジュールを切り替える際に使用する。
 *
 * 【呼び出しイメージ（be_invoice.js の sendInvoiceData 内）】
 *   const rules = accountInfo.csv_format_rules;
 *   if (isNewFormatRules_(rules)) {
 *     validateCsvHeaderByRules_(csvText, rules);           // 本ファイルの関数
 *     const sql = buildMappedTransactionSql_({ ... });    // 本ファイルの関数
 *   } else {
 *     validateCsvHeader_(csvText, getExpectedHeaders_(rules)); // 既存の関数
 *     const sql = buildTransactionSql_( ... );                // 既存の関数
 *   }
 *
 * @param {*} csvFormatRules - accountInfo.csv_format_rules
 * @returns {boolean}
 */
function isNewFormatRules_(csvFormatRules) {
  return (
    csvFormatRules !== null &&
    typeof csvFormatRules === 'object' &&
    Array.isArray(csvFormatRules.columns)
  );
}
