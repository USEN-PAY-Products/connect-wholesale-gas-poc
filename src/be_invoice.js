// =============================================================================
// be_invoice.js
//
// 請求データ関連の公開関数（フロントから google.script.run で呼ばれる）を管理する。
//
// 公開関数:
//   sendInvoiceData(csvBase64, summaryData, remarks)
//   fetchInvoices()
//   fetchInvoiceDetail(invoiceId)
//   getMockScheduleData()    ← BackOffice API 実装後に削除
//   getMockBillingHistory()  ← BackOffice API 実装後に削除
//
// 依存:
//   be_config.js        … getConfig_()
//   be_utils.js         … success_(), getOrCreateSubFolder_(), formatTimestamp_(), formatYearMonth_()
//   be_bq_connection.js … loadCsvToBq_(), waitForLoadJob_(), runTransactionSql_(), dropStagingTable_()
//   be_bq_query.js      … fetchInvoicesByWholesaler_(), fetchInvoiceDetail_()
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
    if (i === line.length) { result.push(''); break; }
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
 * データ行は一切読まない。行数によらず処理時間は一定（数ミリ秒）。
 *
 * @param {string}   csvText  - CSV テキスト（UTF-8）
 * @param {string[]} expected - 期待するヘッダー列名の配列（順序込み）
 * @throws {Error} ヘッダー不正時
 */
function validateCsvHeader_(csvText, expected) {
  const firstNewline = csvText.indexOf('\n');
  const headerLine   = firstNewline === -1 ? csvText : csvText.slice(0, firstNewline);
  const cols         = parseCsvLine_(headerLine.replace(/\r$/, ''));
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
    '取引日', '伝票番号', '加盟店コード', '加盟店名', '品目',
    '数量', '数量単位', '単価', '税率区分(%)', '請求金額（税抜）', '備考',
  ];
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
  });
  return map;
}

/**
 * BQ マルチステートメント・トランザクション SQL を組み立てる。
 * BEGIN TRANSACTION 〜 COMMIT を含む SQL 全文を返す。
 *
 * ⚠️ SQL インジェクション対策: remarks 等のユーザー入力は esc() でシングルクォートをエスケープする。
 *    BQ の parameterized queries は GAS の Jobs.query() では使用できないため文字列エスケープで対処。
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

  // SQL 文字列内のシングルクォートを '' でエスケープする（SQLインジェクション対策）
  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

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
    '  ROW_NUMBER() OVER (PARTITION BY si.id ORDER BY s.transaction_date, s.slip_number),',
    '  si.id,',
    '  s.transaction_date, s.item_name, s.quantity, s.quantity_unit, s.unit_price,',
    '  s.tax_rate, s.amount_ex_tax,',
    '  FLOOR(s.amount_ex_tax * s.tax_rate / 100),',
    '  s.invoice_detail_remark',
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
 * Drive フォルダ構造: <DRIVE_ROOT> / <wholesaler_id> / <YYYYMM> / <タイムスタンプ>_original.csv
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
 * @param {string} csvBase64   - 元CSVのBase64エンコード文字列（フロントで UTF-8 エンコード済み）
 * @param {Object} summaryData - フロント確定値 { wholesalerTotal: {...}, merchantTotals: [...] }
 * @param {Object} remarks     - 加盟店別備考 { [customerCode]: string }
 * @returns {{ status: 'success', data: { csv_url: string, invoice_uuid: string } }}
 * @throws {Error} Drive 操作または BQ 書き込み失敗時
 */
function sendInvoiceData(csvBase64, summaryData, remarks) {
  try {
    // ── サーバー側から卸情報を取得（改ざん不可）──────────────────────────
    const accountInfo = getServerAccountInfo_();
    const mappings    = accountInfo.merchant_mappings || [];

    // ── 入力バリデーション ────────────────────────────────────────────────
    if (!csvBase64) throw new Error('csvBase64 が空です');
    if (!summaryData || !summaryData.wholesalerTotal || !Array.isArray(summaryData.merchantTotals)) {
      throw new Error('summaryData の形式が不正です');
    }
    if (!remarks || typeof remarks !== 'object') {
      throw new Error('remarks の形式が不正です');
    }
    if (summaryData.merchantTotals.length === 0) {
      throw new Error('summaryData.merchantTotals が空です');
    }

    // ── merchant_mappings で customerCode を検証し mall_code マップを構築 ──
    const mallCodeMap = buildMallCodeMap_(mappings, summaryData.merchantTotals);

    // ── ② CSV デコード・ヘッダー検証（データ行は読まない）─────────────────
    const csvBytes = Utilities.base64Decode(csvBase64);
    const csvBlob  = Utilities.newBlob(csvBytes, MimeType.CSV);
    const csvText  = csvBlob.getDataAsString('UTF-8');
    const expected = getExpectedHeaders_(accountInfo.csv_format_rules);
    validateCsvHeader_(csvText, expected);
    Logger.log('[CSV] ヘッダー検証完了');

    // ── UUID 生成（全テーブルの結合キー）──────────────────────────────────
    const invoiceUuid = Utilities.getUuid();
    // ⚠️ BQ テーブル名はハイフン不可 → アンダースコアに変換すること
    const stagingId   = 'staging_invoice_lines_' + invoiceUuid.replace(/-/g, '_');

    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const now       = new Date();

    // ── ① Drive 保存（元バイト列のまま保存）────────────────────────────────
    const rootFolder  = DriveApp.getFolderById(config.driveFolderId);
    const userFolder  = getOrCreateSubFolder_(rootFolder, String(accountInfo.wholesaler_id));
    const monthFolder = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName    = formatTimestamp_(now) + '_original.csv';
    const saveBlob    = Utilities.newBlob(csvBytes, MimeType.CSV, fileName);
    const csvFile     = monthFolder.createFile(saveBlob);
    const csvUrl      = csvFile.getUrl();
    Logger.log('[Drive] 保存完了: ' + csvUrl);

    // ── STUB MODE: Drive 保存のみ、BQ 書き込みスキップ ───────────────────
    if (STUB_MODE) {
      Logger.log('[STUB] Drive 保存完了: ' + csvUrl);
      Logger.log('[STUB] BQ 書き込みはスキップします（STUB_MODE=true）');
      return success_({ csv_url: csvUrl, invoice_uuid: invoiceUuid });
    }

    // ── ③ 生CSV を BQ Load Job で staging テーブルへ投入 ─────────────────
    Logger.log('[BQ] Load Job 投入: stagingId=' + stagingId);
    const jobId = loadCsvToBq_(projectId, datasetId, stagingId, csvBytes);

    // ── ④ Load Job 完了待ち（ポーリング）────────────────────────────────
    waitForLoadJob_(projectId, jobId);

    // ── ⑤ BEGIN TRANSACTION で子・孫・親を一括 INSERT ───────────────────
    const sql = buildTransactionSql_(
      invoiceUuid, stagingId, summaryData, remarks,
      accountInfo, mallCodeMap, csvUrl, projectId, datasetId
    );
    Logger.log('[BQ] トランザクション SQL 実行: invoiceUuid=' + invoiceUuid);
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
// TODO: バックオフィスAPI実装後に fetchInvoicesByWholesaler_() に差し替える
// =============================================================================

/**
 * ログインユーザーの請求一覧を返す。
 * 現在はモックデータを返す。BackOffice API 実装後に be_bq_query.js の
 * fetchInvoicesByWholesaler_() を呼び出す実装に差し替えること。
 *
 * @returns {{ status: 'success', data: Array<Object> }}
 */
function fetchInvoices() {
  try {
    // TODO: return success_(fetchInvoicesByWholesaler_(getWholesalerId_()));
    return getMockBillingHistory();
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
 * be_bq_query.js の fetchInvoiceDetail_() を呼び出す実装に差し替えること。
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
// モックデータ定数  ── BackOffice API 実装後に削除する
// ※ フロント側フォールバック（fe_js.html 内の home.js）と同一形式を維持すること
// =============================================================================

/** @type {Array<{date:string, title:string, type:string}>} */
const MOCK_SCHEDULE_ = [
  { date: '2026-05-13', title: '請求確定', type: 'billing' },
  { date: '2026-05-27', title: '口座振替', type: 'payment' },
];

/** 請求履歴1件分の共通フィールド。id / monthLabel は各エントリで上書きする。 */
const MOCK_BILLING_BASE_ = {
  billingAmount: 99999999,
  subtotalExTax: 90000000,
  taxAmount:     9999999,
  breakdown: [
    { rate: 10, subtotalExTax: 49999999, taxAmount: 4999999 },
    { rate: 8,  subtotalExTax: 50000000, taxAmount: 4000000 },
  ],
  fee:            9999999,
  transferAmount: 990000000,
  status:        '支払完了',
};

/** @type {Array<{id:string, monthLabel:string}>} */
const MOCK_BILLING_ENTRIES_ = [
  { id: 'b001', monthLabel: '4月' },
  { id: 'b002', monthLabel: '3月' },
  { id: 'b003', monthLabel: '2月' },
  { id: 'b004', monthLabel: '1月' },
];

// =============================================================================
// モック公開関数  ── BackOffice API 実装後に削除する
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

/**
 * 請求履歴のモックを返す。
 * @returns {{ status: 'success', data: Array }}
 */
function getMockBillingHistory() {
  try {
    const items = MOCK_BILLING_ENTRIES_.map(function(entry) {
      return Object.assign({}, MOCK_BILLING_BASE_, entry);
    });
    return success_(items);
  } catch (err) {
    throw new Error('getMockBillingHistory failed: ' + err.message);
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

  // デフォルトCSVフォーマットに合わせたサンプルCSV（UTF-8）
  const headers = '取引日,伝票番号,加盟店コード,加盟店名,品目,数量,数量単位,単価,税率区分(%),請求金額（税抜）,備考';
  const dataRow = '2026-05-01,1001,C001,テスト加盟店,テスト品目,1,個,1000,10,1000,テスト備考';
  const dummyCsv = headers + '\r\n' + dataRow + '\r\n';
  const dummyBase64 = Utilities.base64Encode(dummyCsv);

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

  const result = sendInvoiceData(dummyBase64, summaryData, remarks);
  Logger.log('テスト結果: ' + JSON.stringify(result));
}
