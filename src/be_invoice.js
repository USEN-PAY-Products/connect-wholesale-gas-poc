// =============================================================================
// be_invoice.js
//
// 請求データ関連の公開関数（フロントから google.script.run で呼ばれる）を管理する。
//
// 公開関数:
//   sendInvoiceData(rawCsvBase64, utf8CsvBase64, summaryData, remarks)
//   fetchInvoices()            ← サーバー側で wholesaler_id を確定（引数不要）
//   fetchInvoiceDetail(invoiceId)
//   getMockScheduleData()    ← BackOffice API 実装後に削除
//
// 依存:
//   be_config.js        … getConfig_()
//   be_utils.js         … success_(), getOrCreateSubFolder_(), formatTimestamp_(), formatYearMonth_()
//   db_bq_connection.js … loadCsvToBq_(), waitForLoadJob_(), runTransactionSql_(), dropStagingTable_()
//   db_bq_query.js      … fetchInvoicesByWholesaler_(), fetchInvoiceDetail_()
// =============================================================================

// =============================================================================
// 請求登録
// =============================================================================

/**
 * CSV の1行をフィールド配列にパースする（RFC 4180 準拠、状態機械ベース）。
 * ヘッダー行の検証のみに使用する（データ行はパースしない）。
 *
 * @param {string} line - 改行を含まない1行
 * @returns {string[]}
 */
function parseCsvLine_(line) {
  const result = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      // 末尾カンマがある場合のみ空フィールドを追加する。
      // クォートフィールド終端後など、カンマなしで行末に達した場合は追加しない。
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
 * CSV のヘッダー行のみを検証する（列数・列名チェック）。
 * データ行は一切読まない（ヘッダー行のみパースする）。
 * ※ただし呼び出し側で CSV 全体を UTF-8 文字列化しているため、処理コストはファイルサイズに比例する。
 *
 * @param {string}   csvText  - CSV テキスト（UTF-8）
 * @param {string[]} expected - 期待するヘッダー列名の配列（順序込み）
 * @throws {Error} ヘッダー不正時
 */
function validateCsvHeader_(csvText, expected) {
  const firstNewline = csvText.indexOf('\n');
  const headerLine   = firstNewline === -1 ? csvText : csvText.slice(0, firstNewline);
  const cols         = parseCsvLine_(headerLine.replace(/^\uFEFF/, '').replace(/\r$/, ''));
  if (cols.length !== expected.length) {
    throw new Error(
      'CSVヘッダーの列数が不正です（' + cols.length + '列 / 期待値: ' + expected.length + '列）'
    );
  }
  expected.forEach((name, idx) => {
    if (cols[idx] !== name) {
      throw new Error(
        'CSVヘッダー ' + (idx + 1) + '列目が不正: 期待値="' + name + '" 実際="' + cols[idx] + '"'
      );
    }
  });
}

/**
 * csv_format_rules から期待ヘッダー列名の配列を返す。
 * accountInfo.csv_format_rules が null の場合はデフォルトフォーマットを使用。
 *
 * @param {Object|null} csvFormatRules - accountInfo.csv_format_rules
 * @returns {string[]}
 */
function getExpectedHeaders_(csvFormatRules) {
  if (csvFormatRules && Object.keys(csvFormatRules).length > 0) {
    return Object.values(csvFormatRules).map((rule) => rule.csv_header);
  }
  return [
    '顧客コード', '日付', '品目', '数量', '単価',
    '税率区分(%)', '請求金額（税抜）', '消費税', '備考',
  ];
}

/**
 * csv_format_rules から BQ Load Job 用の staging スキーマを動的生成する。
 * 各ルールに bq_field（staging フィールド名）と type（BQ 型）が必要。
 *
 * デフォルトフォーマット（csv_format_rules = null）の場合は null を返し、
 * 呼び出し側で STAGING_SCHEMA_（固定）にフォールバックさせる。
 *
 * SQL の SELECT / JOIN で参照する必須フィールドが揃っているかも検証する。
 *
 * @param {Object|null} csvFormatRules - accountInfo.csv_format_rules
 * @returns {Object|null} BQ スキーマオブジェクト、またはデフォルト使用の場合 null
 * @throws {Error} bq_field 未設定 / 必須フィールド不足の場合
 */
function buildStagingSchema_(csvFormatRules) {
  if (!csvFormatRules || Object.keys(csvFormatRules).length === 0) {
    return null; // STAGING_SCHEMA_（固定9列）を使用
  }

  // buildTransactionSql_ の INSERT SELECT / JOIN で参照する必須フィールド
  const REQUIRED_BQ_FIELDS = [
    'transaction_date', // INSERT: invoice_lines.transaction_date
    'customer_code',    // JOIN: wholesaler_merchants.customer_code
    'item_name',        // INSERT: invoice_lines.item_name
    'quantity',         // INSERT: invoice_lines.quantity
    'unit_price',       // INSERT: invoice_lines.unit_price
    'tax_rate',         // INSERT: invoice_lines.tax_category
    'amount_ex_tax',    // INSERT: invoice_lines.line_amount_excluding_tax
  ];

  // csv_format_rules の type → BQ 型
  const TYPE_MAP = { date: 'DATE', integer: 'INTEGER', string: 'STRING' };

  const fields = Object.values(csvFormatRules).map(function(rule) {
    if (!rule.bq_field) {
      throw new Error(
        'csv_format_rules に bq_field が未設定の列があります: csv_header="' + rule.csv_header + '"'
      );
    }
    return { name: rule.bq_field, type: TYPE_MAP[rule.type] || 'STRING' };
  });

  // 必須フィールドの存在チェック
  const fieldNames = new Set(fields.map(function(f) { return f.name; }));
  REQUIRED_BQ_FIELDS.forEach(function(f) {
    if (!fieldNames.has(f)) {
      throw new Error(
        'csv_format_rules に必須の bq_field が不足しています: "' + f + '"\n' +
        '（buildTransactionSql_ の SQL で参照されるフィールドです）'
      );
    }
  });

  return { fields: fields };
}

/**
 * merchant_mappings から customer_code → mall_code のマップを構築する。
 * summaryData の customerCode が全て merchant_mappings に存在するかも検証する（改ざん防止）。
 *
 * @param {Array<Object>} mappings       - accountInfo.merchant_mappings
 * @param {Array<Object>} merchantTotals - summaryData.merchantTotals
 * @returns {Object} { [customerCode]: mallCode }
 * @throws {Error} 未登録の customerCode が summaryData に含まれる場合
 */
function buildMallCodeMap_(mappings, merchantTotals) {
  const map = {};
  (mappings || []).forEach((m) => {
    if (m.is_active !== false) map[String(m.customer_code)] = String(m.mall_code || '');
  });
  (merchantTotals || []).forEach((m) => {
    const cc = String(m.customerCode || '');
    if (!(cc in map)) {
      throw new Error('summaryData に未登録の customerCode が含まれています: "' + cc + '"');
    }
    if (!map[cc]) {
      throw new Error('mall_code が未設定の customerCode が含まれています: "' + cc + '"');
    }
  });
  return map;
}

/**
 * BQ マルチステートメント・トランザクション SQL を組み立てる。
 * BEGIN TRANSACTION 〜 COMMIT を含む SQL 全文を返す。
 *
 * ⚠️ SQL インジェクション対策:
 *   BQ の named parameter（@param_name）は単一ステートメントでは機能する（db_bq_query.js 参照）が、
 *   BEGIN TRANSACTION 〜 COMMIT を含むマルチステートメントスクリプト内では使用できない。
 *   （BQ の仕様制限）
 *   そのため、ユーザー入力値には次の対策を併用する:
 *     - 文字列（remarks 等）: esc() でシングルクォートをエスケープ
 *     - 数値（金額等）: Number() でキャスト + 非有限大・ NaN の事前検証（本関数内で実施）
 *     - ID 値（UUID 等）: 正規表現でフォーマット検証（本関数内で実施）
 *
 * @param {string} invoiceUuid - 請求UUID
 * @param {string} stagingId   - staging テーブル名（ハイフンなし）
 * @param {Object} summaryData - フロント確定値 { wholesalerTotal, merchantTotals }
 * @param {Object} remarks     - 加盟店別備考 { customerCode: string }
 * @param {Object} accountInfo - getServerAccountInfo_() の返り値
 * @param {Object} mallCodeMap - buildMallCodeMap_() の返り値
 * @param {string} csvUrl      - Drive 保存後の CSV URL
 * @param {string} projectId   - GCP プロジェクトID
 * @param {string} datasetId   - BQ データセットID
 * @returns {string} 実行可能な SQL 全文
 */
function buildTransactionSql_(invoiceUuid, stagingId, summaryData, remarks, accountInfo, mallCodeMap, csvUrl, projectId, datasetId) {
  const wsId     = Number(accountInfo.wholesaler_id);
  const wsUserId = String(accountInfo.wholesaler_user_id);
  const feeRate  = Number(accountInfo.fee_rate || 0);
  const wt       = summaryData.wholesalerTotal;

  // ── 入力値の型・範囲検証（SQL インジェクション対策の第一層）──────────────
  // UUID 形式検証（invoiceUuid / wsUserId）
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(invoiceUuid)) {
    throw new Error('[buildTransactionSql_] invoiceUuid の形式が不正です: ' + invoiceUuid);
  }
  if (!UUID_RE.test(wsUserId)) {
    throw new Error('[buildTransactionSql_] wholesaler_user_id の形式が不正です: ' + wsUserId);
  }
  // staging テーブル名検証（アンダースコア・英数字のみ）
  if (!/^[a-zA-Z0-9_]+$/.test(stagingId)) {
    throw new Error('[buildTransactionSql_] stagingId に不正な文字が含まれています: ' + stagingId);
  }
  // 整数型検証（wsId）
  if (!Number.isInteger(wsId) || wsId <= 0) {
    throw new Error('[buildTransactionSql_] wholesaler_id が不正です: ' + wsId);
  }
  // 卸合計値の有限性・非負・整数・NaN検証
  const numFields = ['totalAmount','subtotalAmount','taxAmount','exTax10','tax10','exTax8','tax8','feeAmount','paymentAmount'];
  numFields.forEach(function(f) {
    const v = Number(wt[f] || 0);
    if (!isFinite(v)) throw new Error('[buildTransactionSql_] wholesalerTotal.' + f + ' が数値ではありません: ' + wt[f]);
    if (v < 0) throw new Error('[buildTransactionSql_] wholesalerTotal.' + f + ' に負数は許可されていません: ' + v);
    if (!Number.isInteger(v)) throw new Error('[buildTransactionSql_] wholesalerTotal.' + f + ' は整数である必要があります: ' + v);
  });
  // 加盟店合計値の有限性・非負・整数・NaN検証
  const merchantNumFields = ['totalAmount','subtotalAmount','taxAmount','exTax10','tax10','exTax8','tax8'];
  summaryData.merchantTotals.forEach(function(m, idx) {
    merchantNumFields.forEach(function(f) {
      const v = Number(m[f] || 0);
      if (!isFinite(v)) throw new Error('[buildTransactionSql_] merchantTotals[' + idx + '].' + f + ' が数値ではありません: ' + m[f]);
      if (v < 0) throw new Error('[buildTransactionSql_] merchantTotals[' + idx + '].' + f + ' に負数は許可されていません: ' + v);
      if (!Number.isInteger(v)) throw new Error('[buildTransactionSql_] merchantTotals[' + idx + '].' + f + ' は整数である必要があります: ' + v);
    });
  });

  // SQL 文字列内のシングルクォートを '' でエスケープする（SQLインジェクション対策）
  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

  // csv_format_rules に存在する bq_field のセット（カスタムフォーマット判定に使用）
  // デフォルト（null）の場合はデフォルト staging フィールドセットを使用する
  const DEFAULT_STAGING_FIELDS_ = new Set([
    'transaction_date', 'customer_code', 'item_name', 'quantity',
    'unit_price', 'tax_rate', 'amount_ex_tax', 'tax_amount', 'invoice_detail_remark',
  ]);
  const csvRules = accountInfo.csv_format_rules;
  const bqFields = csvRules && Object.keys(csvRules).length > 0
    ? new Set(Object.values(csvRules).map(function(r) { return r.bq_field; }))
    : DEFAULT_STAGING_FIELDS_;
  const hasField = function(f) { return bqFields.has(f); };

  // 任意フィールドの SQL 式（なければ NULL で代替）
  const sqlQuantityUnit  = hasField('quantity_unit')         ? 's.quantity_unit'         : 'CAST(NULL AS STRING)';
  const sqlDetailRemark  = hasField('invoice_detail_remark') ? 's.invoice_detail_remark' : 'CAST(NULL AS STRING)';
  // slip_number は ORDER BY 用（なければ transaction_date のみで順序付け）
  const sqlOrderBy = hasField('slip_number')
    ? 'ORDER BY s.transaction_date, s.slip_number'
    : 'ORDER BY s.transaction_date';

  // テーブル参照
  const storeRef     = '`' + projectId + '.' + datasetId + '.store_invoices`';
  const linesRef     = '`' + projectId + '.' + datasetId + '.invoice_lines`';
  const invRef       = '`' + projectId + '.' + datasetId + '.wholesaler_invoices`';
  const stagingRef   = '`' + projectId + '.' + datasetId + '.' + stagingId + '`';
  const merchantsRef = '`' + projectId + '.' + datasetId + '.wholesaler_merchants`';

  // 子（store_invoices）の VALUES を加盟店数分だけ展開する
  const childValues = summaryData.merchantTotals.map((m) => {
    const childUuid = Utilities.getUuid();
    const mallCode  = esc(mallCodeMap[String(m.customerCode)] || '');
    const remark    = esc(remarks[String(m.customerCode)] || '');
    const remarkSql = remark ? "'" + remark + "'" : 'NULL';
    return (
      "('" + childUuid + "', '" + invoiceUuid + "', " + wsId + ", '" + mallCode + "', " +
      Number(m.totalAmount)   + ', ' + Number(m.subtotalAmount) + ', ' + Number(m.taxAmount)  + ', ' +
      Number(m.exTax10 || 0) + ', ' + Number(m.tax10  || 0)    + ', ' +
      Number(m.exTax8  || 0) + ', ' + Number(m.tax8   || 0)    + ', ' +
      remarkSql + ", 'PENDING_REVIEW', 1, '" + esc(wsUserId) + "', CURRENT_DATETIME('Asia/Tokyo'))"
    );
  });

  const lines = [
    'BEGIN TRANSACTION;',
    '',
    '-- 子: store_invoices（フロントの summaryData.merchantTotals から VALUES 展開）',
    'INSERT INTO ' + storeRef,
    '  (id, wholesaler_invoice_id, wholesaler_id, mall_code,',
    '   total_amount, subtotal_amount, tax_amount,',
    '   total_ex_tax_10per, consumption_tax_10per,',
    '   total_ex_tax_8per, consumption_tax_8per,',
    '   wholesaler_handover, backoffice_review_status, is_latest,',
    '   final_updated_by, created_at)',
    'VALUES',
    childValues.join(',\n') + ';',
    '',
    '-- 孫: invoice_lines（staging × wholesaler_merchants × store_invoices JOIN）',
    'INSERT INTO ' + linesRef,
    '  (id, invoice_item_row, store_invoice_id,',
    '   transaction_date, item_name, quantity, quantity_unit, unit_price,',
    '   tax_category, line_amount_excluding_tax, line_tax_amount, line_note)',
    'SELECT',
    '  GENERATE_UUID(),',
    '  ROW_NUMBER() OVER (PARTITION BY si.id ' + sqlOrderBy + '),',
    '  si.id,',
    '  s.transaction_date, s.item_name, s.quantity, ' + sqlQuantityUnit + ', s.unit_price,',
    '  s.tax_rate, s.amount_ex_tax,',
    '  CAST(FLOOR(s.amount_ex_tax * s.tax_rate / 100) AS INT64),',
    '  ' + sqlDetailRemark,
    'FROM ' + stagingRef + ' s',
    'JOIN ' + merchantsRef + ' wm',
    '  ON wm.customer_code = s.customer_code',
    '  AND wm.wholesaler_id = ' + wsId,
    '  AND wm.deleted_at IS NULL',
    'JOIN ' + storeRef + ' si',
    '  ON si.mall_code = wm.mall_code',
    "  AND si.wholesaler_invoice_id = '" + invoiceUuid + "';",
    '',
    '-- 親: wholesaler_invoices（最後に INSERT。失敗しても子・孫はロールバックされる）',
    'INSERT INTO ' + invRef,
    '  (id, wholesaler_user_id, wholesaler_id, wholesaler_invoice_date,',
    '   wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
    '   wholesaler_total_ex_tax_10, wholesaler_consumption_tax_10,',
    '   wholesaler_total_ex_tax_8, wholesaler_consumption_tax_8,',
    '   wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
    '   wholesaler_invoice_csv_url, created_by, created_at)',
    'VALUES',
    "  ('" + invoiceUuid + "', '" + esc(wsUserId) + "', " + wsId + ", CURRENT_DATE('Asia/Tokyo'),",
    '   ' + Number(wt.totalAmount)   + ', ' + Number(wt.subtotalAmount) + ', ' + Number(wt.taxAmount)  + ',',
    '   ' + Number(wt.exTax10 || 0) + ', ' + Number(wt.tax10 || 0) + ',',
    '   ' + Number(wt.exTax8  || 0) + ', ' + Number(wt.tax8  || 0) + ',',
    '   ' + feeRate + ', ' + Number(wt.feeAmount) + ', ' + Number(wt.paymentAmount) + ',',
    "   '" + esc(csvUrl) + "', '" + esc(wsUserId) + "', CURRENT_TIMESTAMP());",
    '',
    'COMMIT;',
  ];
  return lines.join('\n');
}

/**
 * CSV を Drive に保存し、BigQuery の 3 テーブルにトランザクション登録する。
 * Drive フォルダ構造: <DRIVE_ROOT> / <wholesaler_id>_<wholesaler_name> / <YYYYMM> / <タイムスタンプ>_original.csv
 *
 * フロー:
 *   ① Drive に CSV を保存（元ファイル保全）
 *   ② ヘッダー行のみ検証（列数・列名チェック。データ行は読まない）
 *   ③ 生CSV を BQ Load Job で staging テーブルへ投入（GAS は CSV をパースしない）
 *   ④ Load Job 完了待ち（ポーリング）
 *   ⑤ BEGIN TRANSACTION で子・孫・親を一括 INSERT → COMMIT
 *   ⑥ staging テーブルを DROP（TRANSACTION 外）
 *
 * 【セキュリティ】
 *   - wholesaler_id / wholesaler_user_id / mall_code はサーバー側で取得（改ざん防止）
 *   - summaryData.customerCode が merchant_mappings に存在するかをサーバー側で検証
 *   - 金額・備考はフロント確定値をそのまま使用（卸が確認画面で承認した値）
 *
 * 【TODO: 本番実装時の宿題】
 *   summaryData の金額はクライアント確定値のため、悪意ある改ざんを完全には防げない。
 *   POC では以下の理由で割り切る:
 *     - 操作者は卸業者自身（自分が損する改ざんをする動機がない）
 *     - 登録後に backoffice_review_status='PENDING_REVIEW' でバックオフィスが目視確認する
 *     - staging テーブルの明細と金額の突合は、バックオフィス承認フロー内で実施する設計とする
 *   本番実装時は Load Job 完了後に BQ で staging を再集計し、
 *   summaryData との差異が許容範囲を超えた場合はエラーにする仕組みを検討すること。
 *
 * @param {string} rawCsvBase64  - 元CSVのBase64（元ファイルのバイト列そのまま。Drive保存に使用）
 * @param {string} utf8CsvBase64 - UTF-8変換済みCSVのBase64（ヘッダー検証・BQ Load Jobに使用）
 * @param {Object} summaryData - フロント確定値 { wholesalerTotal: {...}, merchantTotals: [...] }
 * @param {Object} remarks     - 加盟店別備考 { [customerCode]: string }
 * @returns {{ status: 'success', data: { csv_url: string, invoice_uuid: string } }}
 * @throws {Error} Drive 操作または BQ 書き込み失敗時
 */
function sendInvoiceData(rawCsvBase64, utf8CsvBase64, summaryData, remarks) {
  try {
    // ── サーバー側から卸情報を取得（改ざん不可）──────────────────────────
    const accountInfo = getServerAccountInfo_();
    const mappings    = accountInfo.merchant_mappings || [];

    // ── 入力バリデーション ────────────────────────────────────────────────
    if (!rawCsvBase64)  throw new Error('rawCsvBase64 が空です');
    if (!utf8CsvBase64) throw new Error('utf8CsvBase64 が空です');
    if (!summaryData || !summaryData.wholesalerTotal || !Array.isArray(summaryData.merchantTotals)) {
      throw new Error('summaryData の形式が不正です');
    }
    if (!remarks || typeof remarks !== 'object') {
      throw new Error('remarks の形式が不正です');
    }
    if (summaryData.merchantTotals.length === 0) {
      throw new Error('summaryData.merchantTotals が空です');
    }

    // ── csv_format_rules から staging スキーマを生成（カスタム対応）────────
    // null の場合は loadCsvToBq_ 内で STAGING_SCHEMA_（固定9列）にフォールバック。
    const stagingSchema = buildStagingSchema_(accountInfo.csv_format_rules);

    // ── merchant_mappings で customerCode を検証し mall_code マップを構築 ──
    const mallCodeMap = buildMallCodeMap_(mappings, summaryData.merchantTotals);

    // ── ② ヘッダー検証（utf8CsvBase64 を使用。データ行は読まない）──────────
    const utf8Bytes = Utilities.base64Decode(utf8CsvBase64);
    const csvText   = Utilities.newBlob(utf8Bytes, MimeType.CSV).getDataAsString('UTF-8');
    // csv_format_rules の形式により検証関数を切り替える。
    //   新形式（columns 配列）: be_csv_mapper.js の validateCsvHeaderByRules_() を使用
    //   旧形式（キー名オブジェクト）: 既存の validateCsvHeader_() をそのまま使用
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      validateCsvHeaderByRules_(csvText, accountInfo.csv_format_rules); // be_csv_mapper.js
    } else {
      const expected = getExpectedHeaders_(accountInfo.csv_format_rules);
      validateCsvHeader_(csvText, expected);
    }
    Logger.log('[CSV] ヘッダー検証完了');

    // ── UUID 生成（全テーブルの結合キー）──────────────────────────────────
    const invoiceUuid = Utilities.getUuid();
    // ⚠️ BQ テーブル名はハイフン不可 → アンダースコアに変換すること
    const stagingId   = 'staging_invoice_lines_' + invoiceUuid.replace(/-/g, '_');

    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const location  = config.bqLocation;
    const now       = new Date();

    // ── ① Drive 保存（rawCsvBase64: 元ファイルのバイト列をそのまま保存）──────
    const rawBytes    = Utilities.base64Decode(rawCsvBase64);
    const rootFolder  = DriveApp.getFolderById(config.driveFolderId);
    const folderName  = accountInfo.wholesaler_id + '_' + accountInfo.wholesaler_name;
    const userFolder  = getOrCreateSubFolder_(rootFolder, folderName);
    const monthFolder = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName    = formatTimestamp_(now) + '_original.csv';
    const saveBlob    = Utilities.newBlob(rawBytes, MimeType.CSV, fileName);
    const csvFile     = monthFolder.createFile(saveBlob);
    const csvUrl      = csvFile.getUrl();
    Logger.log('[Drive] 保存完了: ' + csvUrl);

    // ── ③ 生CSV を BQ Load Job で staging テーブルへ投入（utf8Bytes を使用）──
    Logger.log('[BQ] Load Job 投入: stagingId=' + stagingId);
    const jobId = loadCsvToBq_(projectId, datasetId, stagingId, utf8Bytes, stagingSchema, location);

    // ── ⑤ Load Job 完了待ち（ポーリング）────────────────────────
    waitForLoadJob_(projectId, jobId, location);

    // ── ⑤ BEGIN TRANSACTION で子・孫・親を一括 INSERT ───────────────────
    // csv_format_rules の形式により SQL 組み立て関数を切り替える。
    //   新形式（columns 配列）: be_csv_mapper.js の buildMappedTransactionSql_() を使用
    //   旧形式（キー名オブジェクト）: 既存の buildTransactionSql_() をそのまま使用
    let sql;
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      sql = buildMappedTransactionSql_({                    // be_csv_mapper.js
        invoiceUuid, stagingId, summaryData, remarks,
        accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
        csvFormatRules: accountInfo.csv_format_rules,
      });
    } else {
      sql = buildTransactionSql_(                           // 既存（旧形式）
        invoiceUuid, stagingId, summaryData, remarks,
        accountInfo, mallCodeMap, csvUrl, projectId, datasetId
      );
    }
    Logger.log('[BQ] トランザクション SQL 実行: invoiceUuid=' + invoiceUuid);
    Logger.log('[BQ] SQL全文:\n' + sql);
    runTransactionSql_(projectId, sql);

    // ── ⑥ staging テーブルを DROP（TRANSACTION 外）─────────────────────
    // DROP 失敗はフロントにエラーを返さない（DB への登録は完了しているため）
    try {
      dropStagingTable_(projectId, datasetId, stagingId);
    } catch (dropErr) {
      Logger.log('[BQ] ⚠️ staging DROP 失敗（手動削除が必要）: ' + dropErr.message);
    }

    Logger.log('[sendInvoiceData] 完了: invoiceUuid=' + invoiceUuid);
    return success_({ csv_url: csvUrl, invoice_uuid: invoiceUuid });
  } catch (err) {
    throw new Error('sendInvoiceData failed: ' + err.message);
  }
}


// =============================================================================
// 請求一覧取得
// =============================================================================

/**
 * ログインユーザーの請求一覧を BQ から取得して返す。
 * wholesaler_id はサーバー側で getServerAccountInfo_() から取得する（引数は無視）。
 * フロントから渡された引数を使わないことで sessionStorage 改ざんによる他卸データ取得を防ぐ。
 *
 * @returns {{ status: 'success', data: Array<Object> }}
 */
function fetchInvoices() {
  try {
    const accountInfo  = getServerAccountInfo_();
    const wholesalerId = accountInfo.wholesaler_id;
    return success_(fetchInvoicesByWholesaler_(wholesalerId));
  } catch (err) {
    throw new Error('fetchInvoices failed: ' + err.message);
  }
}

// =============================================================================
// 請求詳細取得
// TODO: バックオフィスAPI実装後に fetchInvoiceDetail_() に差し替える
// =============================================================================

/**
 * 指定した請求IDの詳細データを返す。
 * 現在は null を返す（詳細画面未実装）。BackOffice API 実装後に
 * db_bq_query.js の fetchInvoiceDetail_() を呼び出す実装に差し替えること。
 *
 * @param {string|number} invoiceId - 取得対象の請求管理番号
 * @returns {{ status: 'success', data: Object|null }}
 */
function fetchInvoiceDetail(invoiceId) {
  try {
    // TODO: return success_(fetchInvoiceDetail_(invoiceId));
    return success_(null);
  } catch (err) {
    throw new Error('fetchInvoiceDetail failed: ' + err.message);
  }
}

// =============================================================================
// モックデータ定数
// =============================================================================

/** @type {Array<{date:string, title:string, type:string}>} */
const MOCK_SCHEDULE_ = [
  { date: '2026-05-13', title: '請求確定', type: 'billing' },
  { date: '2026-05-27', title: '口座振替', type: 'payment' },
];

// =============================================================================
// モック公開関数
// =============================================================================

/**
 * スケジュールデータのモックを返す。
 * @returns {{ status: 'success', data: Array }}
 */
function getMockScheduleData() {
  try {
    return success_(MOCK_SCHEDULE_);
  } catch (err) {
    throw new Error('getMockScheduleData failed: ' + err.message);
  }
}

// =============================================================================
// テスト用関数  ── 動作確認が終わったら削除してOK
// =============================================================================

/**
 * sendInvoiceData の動作確認用。
 * Script Property "ENV" が "development" のときのみ実行可能。
 *
 * ※ STUB_ACCOUNT_INFO_MODE=true かつ CSV の customer_code が "C001" であること。
 */
function testSendInvoice_() {
  const env = PropertiesService.getScriptProperties().getProperty('ENV');
  if (env !== 'development') {
    throw new Error('testSendInvoice_() は development 環境でのみ実行できます (ENV=' + env + ')');
  }

  // デフォルトCSVフォーマット（9列）に合わせたサンプルCSV（UTF-8）
  // 列順: 顧客コード,日付,品目,数量,単価,税率区分(%),請求金額（税抜）,消費税,備考
  const headers = '顧客コード,日付,品目,数量,単価,税率区分(%),請求金額（税抜）,消費税,備考';
  const dataRow = 'C001,2026-05-01,テスト品目,1,1000,10,1000,100,テスト備考';
  const dummyCsv = headers + '\r\n' + dataRow + '\r\n';
  // rawCsvBase64: Drive 保存用（元バイト列そのまま）
  // utf8CsvBase64: BQ Load Job / ヘッダー検証用（UTF-8 変換済み）
  // ※ テスト用サンプルは元から UTF-8 のため両者は同値
  const dummyRawBase64  = Utilities.base64Encode(dummyCsv);
  const dummyUtf8Base64 = Utilities.base64Encode(dummyCsv);

  // フロントから渡される summaryData / remarks のダミー
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
      exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0,
      feeAmount: 55, paymentAmount: 1045,
    },
    merchantTotals: [
      { customerCode: 'C001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
        exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };
  const remarks = { 'C001': 'テスト備考（手動入力）' };

  const result = sendInvoiceData(dummyRawBase64, dummyUtf8Base64, summaryData, remarks);
  Logger.log('テスト結果: ' + JSON.stringify(result));
}
