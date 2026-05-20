// =============================================================================
// ★ STUB MODE ★
// BQテーブルおよびバックオフィスAPIの準備が完了するまで true にしておく。
// 準備が完了したら false に変更して clasp push する。
// =============================================================================
/** Drive保存・BQ書き込みのスタブ。false = 本番動作。 */
var STUB_MODE = false;
/** getAccountInfo のスタブ。バックオフィスAPIが未整備の間は true にしておく。 */
var STUB_ACCOUNT_INFO_MODE = true;

/** getAccountInfo のスタブ返却値。実際のAPIレスポンス構造に合わせる。 */
var STUB_ACCOUNT_INFO = {
  wholesaler_id:      1,
  wholesaler_user_id: 1,
  wholesaler_name:    '（スタブ）卸業者サンプル',
  user_name:          'スタブ 太郎',
  fee_rate:           5,
  merchant_mappings: [
    { customer_code: 'C001', mall_code: 'MALL-001', merchant_name: 'サンプル加盟店A' },
    { customer_code: 'C002', mall_code: 'MALL-002', merchant_name: 'サンプル加盟店B' },
  ],
  csv_format_rules: null,   // null = デフォルトフォーマットを使用
};

// =============================================================================
// Private utility helpers
// =============================================================================

function success_(data) {
  return { status: 'success', data: data };
}

function error_(message, data) {
  return { status: 'error', message: message, data: data || null };
}

function getWholesalerId_() {
  const email = Session.getActiveUser().getEmail();
  const atIndex = email.indexOf('@');
  if (atIndex === -1) throw new Error('ユーザーのメールアドレスが取得できませんでした');
  // ローカルパート（@より前）を卸IDとして使用し、個人メールアドレス全文の外部漏洩を避ける
  return email.slice(0, atIndex);
}

function getOrCreateSubFolder_(parentFolder, name) {
  const folders = parentFolder.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(name);
}

function formatTimestamp_(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '_' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function formatYearMonth_(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + pad(date.getMonth() + 1);
}

// =============================================================================
// 1. doGet
// =============================================================================

function doGet(e) {
  return HtmlService.createTemplateFromFile('fe_index')
    .evaluate()
    .setTitle('Shiire System')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// =============================================================================
// 2. getAccountInfo
// =============================================================================

/**
 * バックオフィスGASのアカウント情報取得APIを呼び出し、卸情報を返す。
 * フロントエンドの DOMContentLoaded 時に google.script.run 経由で呼ばれる。
 *
 * @returns {{ status: 'success', data: Object }}
 * @throws {Error} API エラー時
 */
function getAccountInfo() {
  // ★ STUB MODE ★
  if (STUB_ACCOUNT_INFO_MODE) {
    Logger.log('[STUB] getAccountInfo: スタブデータを返します');
    return success_(STUB_ACCOUNT_INFO);
  }

  try {
    const config = getConfig_();
    const email  = Session.getActiveUser().getEmail();

    const payload = {
      api_key:             config.apiKey,
      wholesaler_user_id:  email,
    };

    const options = {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    const response     = UrlFetchApp.fetch(config.accountApiUrl, options);
    const responseCode = response.getResponseCode();
    const rawText      = response.getContentText();
    let responseBody;
    try {
      responseBody = JSON.parse(rawText);
    } catch (_) {
      responseBody = rawText;
    }

    if (responseCode < 200 || responseCode >= 300) {
      throw new Error('AccountInfo API error (HTTP ' + responseCode + '): ' + JSON.stringify(responseBody));
    }
    if (responseBody && responseBody.status === 'error') {
      throw new Error('AccountInfo API error (' + responseBody.error_type + '): ' + JSON.stringify(responseBody));
    }
    return success_(responseBody);
  } catch (err) {
    throw new Error('getAccountInfo failed: ' + err.message);
  }
}

// =============================================================================
// 3. sendInvoiceData
// =============================================================================

/**
 * CSV を Drive に保存し、BigQuery の 3 テーブルに登録する。
 * Drive フォルダ構造: <DRIVE_ROOT> / <卸名> / <YYYYMM> / <タイムスタンプ>_original.csv
 *
 * @param {Array<Object>} jsonData        - パース済み請求行データの配列（現在未使用）
 * @param {string}        csvBase64       - 元CSVのBase64エンコード文字列
 * @param {string}        wholesalerName  - 卸業者名（Driveフォルダ名に使用）
 * @param {Object}        bqPayload       - フロントが組み立てた BQ 登録用ペイロード
 * @returns {{ status: 'success', data: { csv_url: string } }}
 * @throws {Error} Drive 操作または BQ 書き込み失敗時
 */
function sendInvoiceData(jsonData, csvBase64, wholesalerName, bqPayload) {
  try {
    const config     = getConfig_();
    const now        = new Date();
    const folderName = wholesalerName || '不明';

    // ── Drive 保存（元バイト列のまま保存）─────────────────────────────────────
    const rootFolder  = DriveApp.getFolderById(config.driveFolderId);
    const userFolder  = getOrCreateSubFolder_(rootFolder, folderName);
    const monthFolder = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName    = formatTimestamp_(now) + '_original.csv';
    const csvBytes    = Utilities.base64Decode(csvBase64);
    const csvBlob     = Utilities.newBlob(csvBytes, MimeType.CSV, fileName);
    const csvFile     = monthFolder.createFile(csvBlob);
    const csvUrl      = csvFile.getUrl();

    // ── STUB MODE: Drive 保存のみ、BQ 書き込みスキップ ─────────────────────
    if (STUB_MODE) {
      Logger.log('[STUB] Drive 保存完了: ' + csvUrl);
      Logger.log('[STUB] BQ 書き込みはスキップします（テーブル未作成）');
      return success_({ csv_url: csvUrl });
    }

    // ── BQ 登録 ───────────────────────────────────────────────────────────────
    if (!bqPayload) {
      throw new Error('bqPayload が null です。フロントから正しく渡されていません。');
    }

    var payload = bqPayload;

    Logger.log('[BQ] wholesalerInvoiceRow: ' + JSON.stringify(payload.wholesalerInvoiceRow));
    Logger.log('[BQ] merchantInvoiceRows件数: ' + (payload.merchantInvoiceRows || []).length);
    Logger.log('[BQ] invoiceLineRows件数: ' + (payload.invoiceLineRows || []).length);

    // csv_url を Drive 保存後の実 URL にセット
    payload.wholesalerInvoiceRow.wholesaler_invoice_csv_url = csvUrl;

    var projectId = config.gcpProjectId;
    var datasetId = config.bqDatasetId;

    // 1. wholesaler_invoices
    insertRows_(projectId, datasetId, 'wholesaler_invoices', [payload.wholesalerInvoiceRow]);

    // 2. merchant_invoices
    if (payload.merchantInvoiceRows && payload.merchantInvoiceRows.length > 0) {
      insertRows_(projectId, datasetId, 'merchant_invoices', payload.merchantInvoiceRows);
    }

    // 3. invoice_lines
    if (payload.invoiceLineRows && payload.invoiceLineRows.length > 0) {
      insertRows_(projectId, datasetId, 'invoice_lines', payload.invoiceLineRows);
    }

    return success_({ csv_url: csvUrl });
  } catch (err) {
    throw new Error('sendInvoiceData failed: ' + err.message);
  }
}

/**
 * BigQuery tabledata.insertAll を呼び出すヘルパー。
 * エラーがあれば例外をスローする。
 * @param {string} projectId
 * @param {string} datasetId
 * @param {string} tableId
 * @param {Array<Object>} rows
 */
function insertRows_(projectId, datasetId, tableId, rows) {
  var body = {
    rows: rows.map(function(row, i) {
      return { insertId: Utilities.getUuid(), json: row };
    })
  };
  var response = BigQuery.Tabledata.insertAll(body, projectId, datasetId, tableId);
  if (response.insertErrors && response.insertErrors.length > 0) {
    var details = response.insertErrors.map(function(e) {
      return 'row[' + e.index + ']: ' + e.errors.map(function(err) {
        return err.reason + ' - ' + err.message;
      }).join(', ');
    }).join(' | ');
    throw new Error('[BQ] ' + tableId + ' の登録エラー: ' + details);
  }
}

// =============================================================================
// 3. fetchInvoices
// =============================================================================

function fetchInvoices() {
  try {
    const config = getConfig_();
    const wholesalerId = getWholesalerId_();
    const url = config.getUrl + '?wholesaler_id=' + encodeURIComponent(wholesalerId);

    const response     = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    const responseCode = response.getResponseCode();
    const rawText      = response.getContentText();
    let responseBody;
    try {
      responseBody = JSON.parse(rawText);
    } catch (_) {
      responseBody = rawText;
    }

    if (responseCode < 200 || responseCode >= 300) {
      throw new Error('BackOffice API error (HTTP ' + responseCode + '): ' + JSON.stringify(responseBody));
    }
    return success_(responseBody);
  } catch (err) {
    throw new Error('fetchInvoices failed: ' + err.message);
  }
}

// =============================================================================
// 4. fetchInvoiceDetail
// =============================================================================

function fetchInvoiceDetail(invoiceId) {
  try {
    const config = getConfig_();
    const wholesalerId = getWholesalerId_();
    const url =
      config.getUrl +
      '?invoice_id='    + encodeURIComponent(invoiceId) +
      '&wholesaler_id=' + encodeURIComponent(wholesalerId);

    const response     = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    const responseCode = response.getResponseCode();
    const rawText      = response.getContentText();
    let responseBody;
    try {
      responseBody = JSON.parse(rawText);
    } catch (_) {
      responseBody = rawText;
    }

    if (responseCode < 200 || responseCode >= 300) {
      throw new Error('BackOffice API error (HTTP ' + responseCode + '): ' + JSON.stringify(responseBody));
    }
    return success_(responseBody);
  } catch (err) {
    throw new Error('fetchInvoiceDetail failed: ' + err.message);
  }
}


// =============================================================================
// 5 & 6. モックデータ定数  ── BackOffice API 実装後に削除する
//   ※ フロント側フォールバック (app.js) と同一のデータ形式を維持すること
// =============================================================================

/** @type {Array<{date:string, title:string, type:string}>} */
var MOCK_SCHEDULE_ = [
  { date: '2026-05-13', title: '請求確定', type: 'billing' },
  { date: '2026-05-27', title: '口座振替', type: 'payment' },
];

/**
 * 請求履歴1件分の共通フィールド。
 * id / monthLabel は各エントリで上書きする。
 */
var MOCK_BILLING_BASE_ = {
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

/** @type {Array<{id:string, monthLabel:string}>} 月ラベルとIDのみ列挙 */
var MOCK_BILLING_ENTRIES_ = [
  { id: 'b001', monthLabel: '4月' },
  { id: 'b002', monthLabel: '3月' },
  { id: 'b003', monthLabel: '2月' },
  { id: 'b004', monthLabel: '1月' },
];

// =============================================================================
// 5. getMockScheduleData
// =============================================================================

function getMockScheduleData() {
  try {
    return success_(MOCK_SCHEDULE_);
  } catch (err) {
    throw new Error('getMockScheduleData failed: ' + err.message);
  }
}

// =============================================================================
// 6. getMockBillingHistory
// =============================================================================

function getMockBillingHistory() {
  try {
    var items = MOCK_BILLING_ENTRIES_.map(function(entry) {
      return Object.assign({}, MOCK_BILLING_BASE_, entry);
    });
    return success_(items);
  } catch (err) {
    throw new Error('getMockBillingHistory failed: ' + err.message);
  }
}

// --- Script Propertiesセットアップヘルパー・テスト用関数は config.js に移動済み ---

// --- テスト用関数（動作確認が終わったら消してOK） ---
// Script Property "ENV" が "development" のときのみ実行可能にする
function testSendInvoice_() {
  const env = PropertiesService.getScriptProperties().getProperty('ENV');
  if (env !== 'development') {
    throw new Error('testSendInvoice_() は development 環境でのみ実行できます (ENV=' + env + ')');
  }
  const dummyJson = [
    {
      storeCode:   'A001',
      date:        '2026-05-01',
      item:        'テスト品目',
      qty:         2,
      unitPrice:   500,
      taxRate:     10,
      amountExTax: 1000,
      tax:         100,
      note:        'テスト備考',
    },
  ];
  const dummyCsv =
    '加盟店コード,日付,品目,数量,単価,税率区分(%),請求金額（税抜）,消費税,備考\r\n' +
    'A001,2026-05-01,テスト品目,2,500,10,1000,100,テスト備考\r\n';
  const result = sendInvoiceData(dummyJson, dummyCsv);
  console.log('テスト結果:', result);
}