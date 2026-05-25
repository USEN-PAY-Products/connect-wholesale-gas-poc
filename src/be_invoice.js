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
//   be_csv_mapper.js    … isNewFormatRules_(), validateCsvHeaderByRules_(), buildMappedTransactionSql_()
//   db_bq_connection.js … loadCsvToBq_(), waitForLoadJob_(), runTransactionSql_(), dropStagingTable_()
//   db_bq_query.js      … fetchInvoicesByWholesaler_(), fetchInvoiceDetail_()
// =============================================================================

// =============================================================================
// 請求登録
// =============================================================================

/**
 * csv_format_rules から BQ Load Job 用の staging スキーマを動的生成する。
 *
 * 返り値の意味:
 *   undefined … csv_format_rules なし（デフォルト卸）→ loadCsvToBq_ が STAGING_SCHEMA_（固定9列）を使用
 *   Object    … 新形式 → loadCsvToBq_ が明示スキーマを使用
 *
 * 新形式（columns 配列あり）の場合は string_field_0〜N を全列 STRING として明示スキーマを生成する。
 * autodetect: true に委ねると BQ が DATE/INT64 等に推論してしまい、
 * 後段の be_csv_mapper.js（NULLIF/PARSE_DATE 等）が型不一致で失敗するため。
 *
 * @param {Object|null} csvFormatRules - accountInfo.csv_format_rules
 * @returns {Object|undefined}
 */
function buildStagingSchema_(csvFormatRules) {
  if (!csvFormatRules || Object.keys(csvFormatRules).length === 0) {
    return undefined; // → loadCsvToBq_ で STAGING_SCHEMA_（固定9列）にフォールバック
  }

  // 新形式（columns 配列を持つ）: 全列 STRING の明示スキーマを生成する。
  // autodetect: true に任せると列が DATE/INT64 に推論される可能性があり、
  // 後段の NULLIF(...,'') や PARSE_DATE(...) が型不一致で失敗する。
  // columns の最大 index + 1 列分を string_field_0〜N として STRING で定義する。
  const maxIndex = csvFormatRules.columns.reduce(function(max, col) {
    return Math.max(max, col.index);
  }, 0);
  const fields = [];
  for (let i = 0; i <= maxIndex; i++) {
    fields.push({ name: 'string_field_' + i, type: 'STRING' });
  }
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

    // ── csv_format_rules から staging スキーマを生成 ────────────────────────
    // undefined → loadCsvToBq_ が STAGING_SCHEMA_（固定9列）を使用（デフォルト卸）
    // Object    → loadCsvToBq_ が明示スキーマを使用（新形式: string_field_0〜N を全列 STRING）
    //   autodetect: true は使用しない（BQ が DATE/INT64 等に推論すると後段 SQL が型不一致で失敗するため）
    const stagingSchema = buildStagingSchema_(accountInfo.csv_format_rules);

    // ── merchant_mappings で customerCode を検証し mall_code マップを構築 ──
    const mallCodeMap = buildMallCodeMap_(mappings, summaryData.merchantTotals);

    // ── ② ヘッダー検証（utf8CsvBase64 を使用。データ行は読まない）──────────
    const utf8Bytes = Utilities.base64Decode(utf8CsvBase64);
    const csvText   = Utilities.newBlob(utf8Bytes, MimeType.CSV).getDataAsString('UTF-8');
    validateCsvHeaderByRules_(csvText, accountInfo.csv_format_rules); // be_csv_mapper.js
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
    const sql = buildMappedTransactionSql_({                // be_csv_mapper.js
      invoiceUuid, stagingId, summaryData, remarks,
      accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
      csvFormatRules: accountInfo.csv_format_rules,
    });
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
 * 親サマリー（wholesaler_invoices 1行）と加盟店一覧（store_invoices）を一括取得する。
 * 孫明細（invoice_lines）はアコーディオン開閉時にオンデマンドで getInvoiceLinesByStore() を呼ぶ設計。
 *
 * @param {string} invoiceId - 取得対象の卸インボイスID
 * @returns {{ status: 'success', data: { summary: Object, stores: Array<Object> } | null }}
 */
function fetchInvoiceDetail(invoiceId) {
  try {
    if (!invoiceId) throw new Error('invoiceId が指定されていません');
    const accountInfo  = getServerAccountInfo_(); // ログインユーザーの権限検証
    const wholesalerId = accountInfo.wholesaler_id;
    const summary = fetchInvoiceDetailSummary_(invoiceId, wholesalerId);
    if (!summary) return success_(null); // 自分の請求書でない or 存在しない
    const stores = fetchStoreInvoicesByParent_(invoiceId, wholesalerId);
    return success_({ summary: summary, stores: stores });
  } catch (err) {
    throw new Error('fetchInvoiceDetail failed: ' + err.message);
  }
}

/**
 * 加盟店インボイスIDに紐づく明細（孫レコード）を最大1000件返す。
 * 詳細画面のアコーディオンがクリックされたタイミングでオンデマンドに呼ばれる。
 *
 * @param {string} storeInvoiceId - 加盟店インボイスID（store_invoices.id）
 * @returns {{ status: 'success', data: Array<Object> }}
 */
function getInvoiceLinesByStore(storeInvoiceId) {
  try {
    if (!storeInvoiceId) throw new Error('storeInvoiceId が指定されていません');
    const accountInfo  = getServerAccountInfo_(); // ログインユーザーの権限検証
    const wholesalerId = accountInfo.wholesaler_id;
    return success_(fetchInvoiceLinesByStore_(storeInvoiceId, wholesalerId));
  } catch (err) {
    throw new Error('getInvoiceLinesByStore failed: ' + err.message);
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
