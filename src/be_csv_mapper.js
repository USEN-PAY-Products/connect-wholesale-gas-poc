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
 *   1. columns に定義された全列（required の有無を問わず）が CSV ヘッダーに存在すること
 *   2. JSON の index と CSV 上の実際の列位置（0始まり）が完全一致すること（位置ズレ検知）
 *
 *   ※ required:false の列も含めて全列を検証する理由:
 *      string_field_N のマッピングは列位置に依存するため、任意列の位置ずれも
 *      全列のデータ破損につながる。ヘッダー段階で全列一致を確認する。
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

  // ── 前提検証: col.index の型・範囲チェック ────────────────────────────────
  // col.index は 's.string_field_N' の N として SQL に直接埋め込まれるため、
  // 0 以上の整数であることをループ前に一括検証する。
  columns.forEach(function(col, i) {
    if (!Number.isInteger(col.index) || col.index < 0) {
      throw new Error(
        '[CsvMapper] columns[' + i + '].index が不正です: ' + JSON.stringify(col.index) + '。' +
        '0 以上の整数を指定してください。'
      );
    }
  });

  // ── 前提検証: index および system_column の重複チェック ───────────────────
  // index 重複 → 同じ string_field_N に複数列がマッピングされて不定の値が使われる
  // system_column 重複 → INSERT カラムが重複して BQ がエラーになる
  // seenSystemColumns は Object.create(null) を使う。
  // {} だと 'constructor' や 'toString' 等の既存プロパティと衝突し、
  // 初回出現でも !== undefined が true になって誤った「重複」エラーになるため。
  const seenIndexes       = {};
  const seenSystemColumns = Object.create(null);
  columns.forEach(function(col, i) {
    if (seenIndexes[col.index] !== undefined) {
      throw new Error(
        '[CsvMapper] columns[' + i + '].index = ' + col.index + ' が重複しています。' +
        '(columns[' + seenIndexes[col.index] + '] と重複)'
      );
    }
    seenIndexes[col.index] = i;

    const sc = col.system_column;
    if (sc && sc !== 'null') {
      if (seenSystemColumns[sc] !== undefined) {
        throw new Error(
          '[CsvMapper] columns[' + i + '].system_column = "' + sc + '" が重複しています。' +
          '(columns[' + seenSystemColumns[sc] + '] と重複)'
        );
      }
      seenSystemColumns[sc] = i;
    }
  });

  // ── 検証0: 列数チェック ───────────────────────────────────────────────────
  // columns[].index は CSV 上の 0 始まり位置を表す。
  // 最大 index + 1 が期待列数。CSV の実際の列数と一致しない場合、
  // string_field_N のマッピングが全列ずれてデータ破損するため即時拒否する。
  const expectedColCount = columns.reduce(function(max, col) {
    return Math.max(max, col.index + 1);
  }, 0);
  if (csvHeaders.length !== expectedColCount) {
    throw new Error(
      '[CsvMapper] CSVの列数が定義と一致しません。' +
      '期待値: ' + expectedColCount + '列, ' +
      '実際: ' + csvHeaders.length + '列。\n' +
      'CSVフォーマットが変更されていないか確認してください。'
    );
  }

  // ── 検証1+2: 各列を index で直接アクセスして名前を照合 ──────────────────
  // indexOf() ではなく csvHeaders[col.index] を直接参照することで、
  // 同名ヘッダーによる誤判定と位置ズレの見逃しを両方防ぐ。
  columns.forEach(function(col) {
    const definedIdx   = col.index;
    const definedName  = col.csv_header;
    const actualName   = csvHeaders[definedIdx]; // 位置を直接参照

    if (actualName === undefined) {
      // index が csvHeaders の範囲外（列数チェックで弾かれるはずだが念のため）
      errors.push(
        '列「' + definedName + '」の定義 index=' + definedIdx + ' が CSV の範囲外です。'
      );
      return;
    }

    if (actualName !== definedName) {
      // 位置は合っているが列名が違う → フォーマット変更 or ルール登録ミス
      const severity = col.required ? '必須列' : '任意列';
      errors.push(
        severity + '「' + definedName + '」の位置（index=' + definedIdx + '）に ' +
        '別の列「' + actualName + '」があります。' +
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
 * 【DDL列名マッピング（system_column → invoice_lines カラム名）】
 *   system_column が staging 名の場合、以下の DDL 列名に変換する:
 *   - tax_rate              → tax_category
 *   - amount_ex_tax         → line_amount_excluding_tax
 *   - invoice_detail_remark → line_note
 *   その他は 1:1 対応（transaction_date, item_name, quantity, quantity_unit, unit_price 等）
 *
 * 【計算項目 line_tax_amount のインジェクション】
 *   CSV に存在しないため、amount_ex_tax と tax_rate の index を逆引きして計算式を生成。
 *   端数処理: FLOOR（切り捨て）
 *
 * 【store_invoice_id の取得】
 *   wholesaler_merchants と store_invoices を JOIN して取得する。
 *   customer_code (system_column) が JOIN キーとして必須。INSERT カラムには含めない。
 *
 * @param {Object} csvFormatRules - 新形式の csv_format_rules（columns 配列を持つ）
 * @param {string} stagingRef     - Staging テーブルの完全修飾参照（バッククォート付き）
 *                                  例: "`project.dataset.staging_invoice_lines_xxxx`"
 * @param {string} invoiceUuid    - 親テーブルの ID（store_invoices の絞り込みに使用）
 * @param {number} wsId           - 卸業者ID（wholesaler_merchants の絞り込みに使用）
 * @param {string} merchantsRef   - wholesaler_merchants テーブルの完全修飾参照
 * @param {string} storeRef       - store_invoices テーブルの完全修飾参照
 * @returns {{ insertColumns: string[], selectSql: string }}
 *   - insertColumns: INSERT 句に使用するカラム名配列
 *   - selectSql:     SELECT ... FROM staging JOIN ... の SQL 文字列（末尾の `;` を含む）
 * @throws {Error} amount_ex_tax, tax_rate, customer_code が columns に定義されていない場合
 */
function buildInvoiceLinesSelectSql_(csvFormatRules, stagingRef, invoiceUuid, wsId, merchantsRef, storeRef) {
  const columns = csvFormatRules.columns;

  // ── 前提検証: col.index の型・範囲チェック ────────────────────────────────
  // col.index は 's.string_field_N' の N として SQL に直接埋め込まれるため、
  // 0 以上の整数であることをループ前に一括検証する。
  columns.forEach(function(col, i) {
    if (!Number.isInteger(col.index) || col.index < 0) {
      throw new Error(
        '[CsvMapper] columns[' + i + '].index が不正です: ' + JSON.stringify(col.index) + '。' +
        '0 以上の整数を指定してください。'
      );
    }
  });

  // ── 前提検証: index および system_column の重複チェック ───────────────────
  // index 重複 → 同じ string_field_N に複数列がマッピングされて不定の値が使われる
  // system_column 重複 → INSERT カラムが重複して BQ がエラーになる
  // seenSystemColumns は Object.create(null) を使う。
  // {} だと 'constructor' や 'toString' 等の既存プロパティと衝突し、
  // 初回出現でも !== undefined が true になって誤った「重複」エラーになるため。
  const seenIndexes       = {};
  const seenSystemColumns = Object.create(null);
  columns.forEach(function(col, i) {
    if (seenIndexes[col.index] !== undefined) {
      throw new Error(
        '[CsvMapper] columns[' + i + '].index = ' + col.index + ' が重複しています。' +
        '(columns[' + seenIndexes[col.index] + '] と重複)'
      );
    }
    seenIndexes[col.index] = i;

    const sc = col.system_column;
    if (sc && sc !== 'null') {
      if (seenSystemColumns[sc] !== undefined) {
        throw new Error(
          '[CsvMapper] columns[' + i + '].system_column = "' + sc + '" が重複しています。' +
          '(columns[' + seenSystemColumns[sc] + '] と重複)'
        );
      }
      seenSystemColumns[sc] = i;
    }
  });

  // system_column → DDL invoice_lines カラム名のマッピング（1:1 でない列のみ定義）
  const SYSTEM_COL_TO_DDL = {
    'tax_rate':              'tax_category',
    'amount_ex_tax':         'line_amount_excluding_tax',
    'invoice_detail_remark': 'line_note',
  };

  // ── invoice_lines INSERT に必須な system_column が揃っているか一括検証 ──────
  // アップロード時（validateCsvHeaderByRules_）でも検証しているが、
  // buildInvoiceLinesSelectSql_() は独立関数として将来も別経路から呼ばれうる。
  // 欠落した場合 NULL のまま INSERT されるか BQ の NOT NULL 制約で失敗するため、
  // ここで早期 throw して原因を明示する。
  // ※ customer_code は INSERT 不要だが store_invoices JOIN キーとして必須のため含む。
  // ※ quantity_unit / invoice_detail_remark は nullable のため除外。
  const REQUIRED_SYSTEM_COLUMNS = [
    { key: 'customer_code',    reason: 'store_invoices との JOIN キーに必要です。' },
    { key: 'transaction_date', reason: 'invoice_lines.transaction_date (NOT NULL) に必要です。' },
    { key: 'item_name',        reason: 'invoice_lines.item_name (NOT NULL) に必要です。' },
    { key: 'quantity',         reason: 'invoice_lines.quantity (NOT NULL) に必要です。' },
    { key: 'unit_price',       reason: 'invoice_lines.unit_price (NOT NULL) に必要です。' },
    { key: 'amount_ex_tax',    reason: 'invoice_lines.line_amount_excluding_tax および line_tax_amount の自動計算に必要です。' },
    { key: 'tax_rate',         reason: 'invoice_lines.tax_category および line_tax_amount の自動計算に必要です。' },
  ];
  REQUIRED_SYSTEM_COLUMNS.forEach(function(req) {
    const found = columns.some(function(c) { return c.system_column === req.key; });
    if (!found) {
      throw new Error(
        '[CsvMapper] csv_format_rules.columns に ' + req.key + ' の定義がありません。' +
        req.reason
      );
    }
  });

  // ── JOIN/計算に必要な列を system_column から逆引き ─────────────────────────
  const amountCol   = columns.find(function(c) { return c.system_column === 'amount_ex_tax'; });
  const taxRateCol  = columns.find(function(c) { return c.system_column === 'tax_rate'; });
  const custCodeCol = columns.find(function(c) { return c.system_column === 'customer_code'; });
  const txDateCol   = columns.find(function(c) { return c.system_column === 'transaction_date'; });

  const amountFieldRef   = 's.string_field_' + amountCol.index;
  const taxRateFieldRef  = 's.string_field_' + taxRateCol.index;
  const custCodeFieldRef = 's.string_field_' + custCodeCol.index;

  // ROW_NUMBER の ORDER BY 式（transaction_date があれば使用）
  let orderByExpr;
  if (txDateCol) {
    const txFieldRef = 's.string_field_' + txDateCol.index;
    if (txDateCol.format === 'YYYYMMDD') {
      orderByExpr = "SAFE.PARSE_DATE('%Y%m%d', " + txFieldRef + ')';
    } else if (txDateCol.format === 'YYYY/MM/DD') {
      orderByExpr = "SAFE.PARSE_DATE('%Y/%m/%d', " + txFieldRef + ')';
    } else if (!txDateCol.format || txDateCol.format === 'YYYY-MM-DD') {
      orderByExpr = txFieldRef; // ISO 8601 は DATE 型として比較可能
    } else {
      throw new Error(
        '[CsvMapper] transaction_date の format が未対応です: "' + txDateCol.format + '"。' +
        '対応フォーマット: YYYYMMDD / YYYY/MM/DD / YYYY-MM-DD'
      );
    }
  } else {
    orderByExpr = '1';
  }

  // ── INSERT カラムリストと SELECT 式を並行して構築 ─────────────────────────
  // validateCases: { countifExpr, message }[] 形式でバリデーション条件を収集する。
  //   新形式は Staging を全列 STRING で読み込むため Load Job の型チェックが利かず、
  //   SAFE_CAST は非数値を NULL に変換するため不正値が静かに取り込まれる恐れがある。
  //   buildMappedTransactionSql_() が DECLARE + SET (CASE WHEN) + IF...RAISE の形に展開し、
  //   staging を1回だけスキャンして全列のエラーを検知する（列ごとの個別スキャンを回避）。
  const insertColumns = ['id', 'invoice_item_row', 'store_invoice_id'];
  const validateCases = []; // { countifExpr: string, message: string }[]
  const selectParts   = [
    '  GENERATE_UUID()                                                    AS id,',
    '  ROW_NUMBER() OVER (PARTITION BY si.id ORDER BY ' + orderByExpr + ') AS invoice_item_row,',
    '  si.id                                                              AS store_invoice_id,',
  ];

  // system_column のホワイトリスト。
  // invoice_lines DDL カラムに対応する許可済み system_column のホワイトリスト。
  // ddlCol = SYSTEM_COL_TO_DDL[sc] || sc で SQL に直接埋め込むため、
  // ここに列挙した識別子のみ INSERT SELECT に使用する。
  // ⚠️ invoice_lines にカラムを追加した場合はここも合わせて更新すること。
  //
  // ホワイトリスト外の system_column（例: slip_number, merchant_name 等）は
  // エラーにせずスキップする。卸のCSVには invoice_lines に保存しない列が含まれることが
  // 多く、都度 ALLOWED_SYSTEM_COLUMNS を更新するのは運用コストが高いため。
  // 未知の値は SQL に埋め込まれないため SQL インジェクションのリスクはない。
  const ALLOWED_SYSTEM_COLUMNS = new Set([
    'customer_code',          // wholesaler_merchants JOIN キー（INSERT不要）
    'transaction_date',       // invoice_lines.transaction_date
    'item_name',              // invoice_lines.item_name
    'quantity',               // invoice_lines.quantity
    'quantity_unit',          // invoice_lines.quantity_unit
    'unit_price',             // invoice_lines.unit_price
    'amount_ex_tax',          // invoice_lines.line_amount_excluding_tax
    'tax_rate',               // invoice_lines.tax_category
    'invoice_detail_remark',  // invoice_lines.line_note
  ]);

  columns.forEach(function(col) {
    const sc = col.system_column;
    if (!sc || sc === null || sc === 'null') return;  // マッピングなし列は除外

    // ホワイトリスト外の system_column は invoice_lines に保存しない列（フロント確認画面用など）。
    // INSERT SELECT には使用しないが、required: true の場合は空チェックバリデーションだけ行う。
    // SQL のカラム名として埋め込まないため SQL インジェクションのリスクはない。
    if (!ALLOWED_SYSTEM_COLUMNS.has(sc)) {
      Logger.log('[CsvMapper] system_column "' + sc + '" は invoice_lines に対応するカラムがないため INSERT をスキップします。');
      if (col.required) {
        const fieldRef = 's.string_field_' + col.index;
        validateCases.push({
          countifExpr: 'COUNTIF(' + fieldRef + " IS NULL OR " + fieldRef + " = '')",
          message:
            '\u5217\u300c' + escSql_(col.csv_header) +
            '\u300d(index:' + col.index + ') \u306f\u5fc5\u9808\u9805\u76ee\u3067\u3059\u3002\u7a7a\u6b04\u306a\u304f\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
        });
      }
      return;
    }

    // customer_code は JOIN キーとして使用するだけ（INSERT不要）
    if (sc === 'customer_code') return;

    const ddlCol   = SYSTEM_COL_TO_DDL[sc] || sc;
    const fieldRef = 's.string_field_' + col.index;
    let castExpr;

    switch (col.type) {
      case 'date':
        // SAFE 系関数を使い、不正日付（例: 20260230）を実行時エラーではなく NULL に変換する。
        // NULL 行は後続の dateValidateSqls（IF...RAISE）でトランザクション冒頭に検知・通知する。
        // これにより全体 INSERT を実行せずに ROLLBACK → 明示的なエラーを返すことができる。
        if (col.format === 'YYYYMMDD') {
          castExpr = "SAFE.PARSE_DATE('%Y%m%d', " + fieldRef + ')';
        } else if (col.format === 'YYYY/MM/DD') {
          castExpr = "SAFE.PARSE_DATE('%Y/%m/%d', " + fieldRef + ')';
        } else if (!col.format || col.format === 'YYYY-MM-DD') {
          // format 未指定または ISO 8601 → SAFE_CAST で対応（DATE() は SAFE 版がない）
          castExpr = 'SAFE_CAST(' + fieldRef + ' AS DATE)';
        } else {
          throw new Error(
            '[CsvMapper] 列「' + col.csv_header + '」(index:' + col.index + ') の' +
            ' format が未対応です: "' + col.format + '"。' +
            '対応フォーマット: YYYYMMDD / YYYY/MM/DD / YYYY-MM-DD'
          );
        }
        // castExpr はこの時点で確定しているため、SELECT 式と同じ式を再利用して
        // 不正日付行を COUNTIF で検知する条件を validateCases に積む。
        // 不正日付（空でないのに parse できない）チェック
        validateCases.push({
          countifExpr:
            'COUNTIF(\n' +
            '      ' + castExpr + ' IS NULL\n' +
            '      AND ' + fieldRef + ' IS NOT NULL\n' +
            "      AND " + fieldRef + " != '')",
          message:
            '\u5217\u300c' + escSql_(col.csv_header) +
            '\u300d(index:' + col.index + ') \u306b\u5b58\u5728\u3057\u306a\u3044\u65e5\u4ed8\u307e\u305f\u306f\u4e0d\u6b63\u306a\u65e5\u4ed8\u304c\u542b\u307e\u308c\u3066\u3044\u307e\u3059\u3002' +
            '\u6709\u52b9\u306a ' + escSql_(col.format || 'YYYY-MM-DD') + ' \u5f62\u5f0f\u306e\u65e5\u4ed8\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
        });
        // required:true の列は空文字・NULL も RAISE する。
        // 上の不正日付チェックは AND field != '' でスキップされるため、別途ガードが必要。
        if (col.required) {
          validateCases.push({
            countifExpr:
              'COUNTIF(' + fieldRef + " IS NULL OR " + fieldRef + " = '')",
            message:
              '\u5217\u300c' + escSql_(col.csv_header) +
              '\u300d(index:' + col.index + ') \u306f\u5fc5\u9808\u9805\u76ee\u3067\u3059\u3002\u7a7a\u6b04\u306a\u304f\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
          });
        }
        break;
      case 'integer':
        // 空セル("") は NULLIF で NULL に変換してから SAFE_CAST する。
        // CAST のみだと空文字・非数値セルで実行時エラーになりトランザクション全体が失敗する。
        castExpr = 'SAFE_CAST(NULLIF(' + fieldRef + ", '') AS INT64)";
        // required:true の列は、空でないのに非数値で SAFE_CAST が NULL になる行を RAISE する。
        // 新形式の Staging は全列 STRING のため Load Job の INTEGER 型チェックが利かず、
        // SAFE_CAST のみでは不正値が静かに NULL として格納されるため。
        if (col.required) {
          // 非数値チェック（空でないのに SAFE_CAST が NULL になる行）
          validateCases.push({
            countifExpr:
              'COUNTIF(\n' +
              '      SAFE_CAST(NULLIF(' + fieldRef + ", '') AS INT64) IS NULL\n" +
              '      AND ' + fieldRef + ' IS NOT NULL\n' +
              "      AND " + fieldRef + " != '')",
            message:
              '\u5217\u300c' + escSql_(col.csv_header) +
              '\u300d(index:' + col.index + ') \u306b\u6570\u5024\u3068\u3057\u3066\u89e3\u91c8\u3067\u304d\u306a\u3044\u5024\u304c\u542b\u307e\u308c\u3066\u3044\u307e\u3059\u3002\u534a\u89d2\u6570\u5b57\u306e\u307f\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
          });
          // 空文字・NULL チェック。
          // NULLIF で空文字を NULL に変換するため上の SAFE_CAST チェックはスキップされる。
          // required:true なら別途ガードが必要。
          validateCases.push({
            countifExpr:
              'COUNTIF(' + fieldRef + " IS NULL OR " + fieldRef + " = '')",
            message:
              '\u5217\u300c' + escSql_(col.csv_header) +
              '\u300d(index:' + col.index + ') \u306f\u5fc5\u9808\u9805\u76ee\u3067\u3059\u3002\u7a7a\u6b04\u306a\u304f\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
          });
        }
        break;
      case 'string':
      default:
        castExpr = fieldRef;
        // 新形式 Staging は全列 STRING のため Load Job の NOT NULL チェックが利かない。
        // required:true の場合は空文字・NULL を RAISE で検知する。
        // date / integer と異なり CAST 変換がないため、シンプルに IS NULL OR = '' を検査する。
        if (col.required) {
          validateCases.push({
            countifExpr:
              'COUNTIF(' + fieldRef + " IS NULL OR " + fieldRef + " = '')",
            message:
              '\u5217\u300c' + escSql_(col.csv_header) +
              '\u300d(index:' + col.index + ') \u306f\u5fc5\u9808\u9805\u76ee\u3067\u3059\u3002\u7a7a\u6b04\u306a\u304f\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
          });
        }
        break;
    }

    insertColumns.push(ddlCol);
    selectParts.push(
      '  ' + padRight_(castExpr, 60) + ' AS ' + ddlCol + ','
      + '  -- ' + sanitizeComment_(col.csv_header) + ' (index: ' + col.index + ')'
    );
  });

  // ── line_tax_amount を計算式でインジェクション ────────────────────────────
  // CSV に存在しない計算項目のため、amount_ex_tax と tax_rate の index から動的に生成する。
  // 計算に使う2列（amount_ex_tax / tax_rate）は required フラグに関わらず非数値が混在すると
  // COALESCE で 0 に補完され、誤った税額 0 の明細が INSERT されてしまう。
  // required:true の場合は columns.forEach の validateCases で既にカバーされているが、
  // required フラグの設定ミスや将来の変更でカバー漏れが生じないよう、
  // ここで amountCol / taxRateCol を改めて明示的にバリデーションする。
  // 重複 WHEN は CASE WHEN の先行条件が先にマッチして中断されるため実害はない。
  [
    { col: amountCol,  fieldRef: amountFieldRef  },
    { col: taxRateCol, fieldRef: taxRateFieldRef },
  ].forEach(function(entry) {
    const col      = entry.col;
    const fieldRef = entry.fieldRef;
    validateCases.push({
      countifExpr:
        'COUNTIF(\n' +
        '      SAFE_CAST(NULLIF(' + fieldRef + ", '') AS INT64) IS NULL\n" +
        '      AND ' + fieldRef + ' IS NOT NULL\n' +
        "      AND " + fieldRef + " != '')",
      message:
        '\u5217\u300c' + escSql_(col.csv_header) +
        '\u300d(index:' + col.index + ') \u306b\u6570\u5024\u3068\u3057\u3066\u89e3\u91c8\u3067\u304d\u306a\u3044\u5024\u304c\u542b\u307e\u308c\u3066\u3044\u307e\u3059\u3002' +
        '\u3053\u306e\u5217\u306f line_tax_amount \u306e\u8a08\u7b97\u306b\u4f7f\u7528\u3059\u308b\u305f\u3081\u6570\u5024\u304c\u5fc5\u9808\u3067\u3059\u3002\u534a\u89d2\u6570\u5b57\u306e\u307f\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    });
  });

  const safeAmount  = 'COALESCE(SAFE_CAST(NULLIF(' + amountFieldRef  + ", '') AS INT64), 0)";
  const safeRate    = 'COALESCE(SAFE_CAST(NULLIF(' + taxRateFieldRef + ", '') AS INT64), 0)";
  const lineTaxExpr = 'CAST(FLOOR(' + safeAmount + ' * ' + safeRate + ' / 100) AS INT64)';

  insertColumns.push('line_tax_amount');
  selectParts.push(
    '  ' + lineTaxExpr + ' AS line_tax_amount,' +
    '  -- 消費税額: FLOOR(金額(index:' + amountCol.index +
    ') × 税率(index:' + taxRateCol.index + ') / 100) 端数切り捨て（非数値は前段 RAISE で排除済み）'
  );

  insertColumns.push('created_at');
  selectParts.push('  CURRENT_TIMESTAMP()                                                 AS created_at');

  const selectSql = [
    'SELECT',
    selectParts.join('\n'),
    'FROM ' + stagingRef + ' s',
    'JOIN ' + merchantsRef + ' wm',
    '  ON wm.customer_code = ' + custCodeFieldRef,
    '  AND wm.wholesaler_id = ' + wsId,
    '  AND wm.deleted_at IS NULL',
    'JOIN ' + storeRef + ' si',
    '  ON si.mall_code = wm.mall_code',
    "  AND si.wholesaler_invoice_id = '" + escSql_(invoiceUuid) + "';",
  ].join('\n');

  Logger.log(
    '[CsvMapper] SELECT SQL 生成完了: ' + insertColumns.length + 'カラム' +
    '（うち計算項目: line_tax_amount）'
  );

  return { insertColumns: insertColumns, selectSql: selectSql, validateCases: validateCases };
}


// =============================================================================
// ③ BEGIN TRANSACTION 〜 COMMIT の全体 DML 組み立て
// =============================================================================

/**
 * BEGIN TRANSACTION 〜 COMMIT を含む全体トランザクション SQL を組み立てる。
 *
 * 【INSERT 順序（孤立リスク最小化）】
 *   1. 子テーブル (store_invoices)       — フロント確定値を VALUES で複数行展開
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
  const q            = function(tbl) { return '`' + projectId + '.' + datasetId + '.' + tbl + '`'; };
  const stagingRef   = q(stagingId);
  const storeRef     = q('store_invoices');
  const merchantsRef = q('wholesaler_merchants');
  const linesRef     = q('invoice_lines');
  const invRef       = q('wholesaler_invoices');

  // ── 孫テーブル用の動的 SELECT SQL を生成 ★アドオン核心 ───────────────────
  // buildInvoiceLinesSelectSql_() が INSERT カラムリストと SELECT 文を同時に返す。
  // validateCases は staging を1回スキャンして全列のエラーを検知するための
  // { countifExpr, message }[] 配列。後続でまとめて CASE WHEN に展開する。
  const { insertColumns, selectSql, validateCases } = buildInvoiceLinesSelectSql_(
    csvFormatRules,
    stagingRef,
    invoiceUuid,
    wsId,
    merchantsRef,
    storeRef
  );

  // ── 子テーブル (store_invoices) の VALUES を加盟店数分だけ展開 ─────────────
  const childRows = summaryData.merchantTotals.map(function(m) {
    const storeUuid = Utilities.getUuid();
    const mallCode  = escSql_(mallCodeMap[String(m.customerCode)] || '');
    const remark    = escSql_(remarks[String(m.customerCode)] || '');
    const remarkSql = remark ? "'" + remark + "'" : 'NULL';
    return (
      '  (' +
      "'" + storeUuid                          + "', " +  // id
      "'" + escSql_(invoiceUuid)               + "', " +  // wholesaler_invoice_id
           wsId                                + ', '  +  // wholesaler_id
      "'" + mallCode                           + "', " +  // mall_code
           Number(m.totalAmount    || 0)       + ', '  +  // total_amount
           Number(m.subtotalAmount || 0)       + ', '  +  // subtotal_amount
           Number(m.taxAmount      || 0)       + ', '  +  // tax_amount
           Number(m.exTax10        || 0)       + ', '  +  // standard_tax_target_amount
           Number(m.tax10          || 0)       + ', '  +  // standard_tax_amount
           Number(m.exTax8         || 0)       + ', '  +  // reduced_tax_target_amount
           Number(m.tax8           || 0)       + ', '  +  // reduced_tax_amount
      '0, '                                             +  // non_taxable_amount
           remarkSql                           + ', '  +  // wholesaler_remark
      "'PENDING_REVIEW', TRUE, '"                        +  // backoffice_review_status, is_latest
      escSql_(wsUserId) + "', CURRENT_TIMESTAMP()"  +  // final_updated_by, created_at
      ')'
    );
  });

  // ── INSERT ... SELECT の invoice_lines 用カラムリスト補足 ──────────────────
  // store_invoice_id は buildInvoiceLinesSelectSql_() 内で store_invoices と JOIN して取得。
  // invoiceUuid は全行共通のため JOIN 条件として埋め込み済み。

  // ── バリデーションブロックを組み立て（staging 1回スキャン版） ────────────────
  // 列ごとに個別 SELECT を発行すると staging を列数分フルスキャンしてしまう。
  // DECLARE + SET (CASE WHEN 複数 COUNTIF) + IF...RAISE の形に集約することで
  // staging を1回だけスキャンして全列のエラーを検知する。
  // CASE WHEN は最初にマッチした WHEN のメッセージを返し、RAISE で即時 ROLLBACK する。
  // BQ 仕様: DECLARE はスクリプトの先頭（BEGIN TRANSACTION の前）にのみ記述可能。
  // SET / IF...RAISE はトランザクション内（BEGIN の後）に記述する。
  const declareBlock = validateCases.length > 0
    ? ['DECLARE _validate_error STRING DEFAULT NULL;', '']
    : [];

  const validateBlock = validateCases.length > 0
    ? [
        '-- =========================================================',
        '-- 0. バリデーション（日付・整数・必須チェック）              ',
        '--    staging を1回だけスキャンして全列のエラーを検知する     ',
        '--    CASE WHEN の最初にマッチしたエラーメッセージを RAISE する',
        '--    RAISE は BQ により自動的に ROLLBACK される（BQ 仕様）   ',
        '-- =========================================================',
        'SET _validate_error = (',
        '  SELECT CASE',
      ].concat(
        validateCases.map(function(c) {
          return (
            '    WHEN ' + c.countifExpr + ' > 0\n' +
            "      THEN '" + c.message + "'"
          );
        })
      ).concat([
        '    ELSE NULL',
        '  END',
        '  FROM ' + stagingRef + ' s',
        ');',
        'IF _validate_error IS NOT NULL THEN',
        '  RAISE USING MESSAGE = _validate_error;',
        'END IF;',
        '',
      ])
    : [];

  // ── 全体 SQL を結合 ──────────────────────────────────────────────────────
  const sqlLines = [
    ...declareBlock,
    'BEGIN TRANSACTION;',
    '',
    ...validateBlock,
    '-- =========================================================',
    '-- 1. 子テーブル (store_invoices)',
    '--    フロントの summaryData.merchantTotals から VALUES を展開',
    '-- =========================================================',
    'INSERT INTO ' + storeRef + ' (',
    '  id, wholesaler_invoice_id, wholesaler_id, mall_code,',
    '  total_amount, subtotal_amount, tax_amount,',
    '  standard_tax_target_amount, standard_tax_amount,',
    '  reduced_tax_target_amount, reduced_tax_amount,',
    '  non_taxable_amount, wholesaler_remark,',
    '  backoffice_review_status, is_latest, final_updated_by, created_at',
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
    '  id, wholesaler_user_id, wholesaler_id, wholesaler_invoice_date,',
    '  wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
    '  wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount,',
    '  wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount,',
    '  wholesaler_non_taxable_amount,',
    '  wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
    '  handover_matter, wholesaler_invoice_csv_url, created_at',
    ')',
    'VALUES (',
    "  '" + escSql_(invoiceUuid)   + "',",
    "  '" + escSql_(wsUserId)      + "', " + wsId + ",",
    "  CURRENT_DATE('Asia/Tokyo'),",
    '  ' + Number(wt.totalAmount   || 0) + ', ' +
          Number(wt.subtotalAmount || 0) + ', ' +
          Number(wt.taxAmount      || 0) + ',',
    '  ' + Number(wt.exTax10       || 0) + ', ' +
          Number(wt.tax10          || 0) + ',',
    '  ' + Number(wt.exTax8        || 0) + ', ' +
          Number(wt.tax8           || 0) + ',',
    '  0,',
    '  ' + feeRate                        + ', ' +
          Number(wt.feeAmount      || 0) + ', ' +
          Number(wt.paymentAmount  || 0) + ',',
    '  NULL,',
    "  '" + escSql_(csvUrl) + "', CURRENT_TIMESTAMP()",
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
 * SQL の -- コメントに埋め込む文字列から改行・制御文字を除去しで1行化する。
 * -- コメントは改行までがコメント範囲のため、csv_header に \n/\r が含まれると
 * コメントが途中で終了し、その後ろに任意の SQL を注入できてしまうため。
 *
 * @param {*} s - サニタイズ対象の値
 * @returns {string}
 * @private
 */
function sanitizeComment_(s) {
  // \n / \r / 制御文字（U+0000–U+001F, U+007F）をスペースに変換して trim
  return String(s == null ? '' : s).replace(/[\x00-\x1F\x7F]/g, ' ').trim();
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
