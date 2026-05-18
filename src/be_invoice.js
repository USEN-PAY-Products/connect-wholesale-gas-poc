// =============================================================================
// Invoice: 請求データ関連のバックエンドロジック
//
// フロントエンドから google.script.run で呼ばれる公開関数と、
// BackOffice API との通信処理を管理する。
//
// 依存: be_utils.js（success_, error_, getWholesalerId_, getOrCreateSubFolder_,
//                    formatTimestamp_, formatYearMonth_）
//       be_config.js（getConfig_）
// =============================================================================

// =============================================================================
// 請求登録
// =============================================================================

/**
 * CSV をドライブに保存し、BackOffice API へ請求データを送信する。
 * フロントエンドの confirm.js から google.script.run 経由で呼ばれる。
 *
 * @param {Array<Object>} jsonData  - パース済み請求行データの配列
 * @param {string}        csvContent - 元CSVの生テキスト（監査証跡保存用）
 * @returns {{ status: 'success', data: * }}
 * @throws {Error} API エラーまたは Drive 操作失敗時
 */
function sendInvoiceData(jsonData, csvContent) {
  try {
    const config = getConfig_();
    const wholesalerId = getWholesalerId_();
    const now = new Date();

    // CSV 監査証跡を Drive に保存
    const rootFolder      = DriveApp.getFolderById(config.driveFolderId);
    const userFolder      = getOrCreateSubFolder_(rootFolder, wholesalerId);
    const monthFolder     = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName        = formatTimestamp_(now) + '_original.csv';
    const csvFile         = monthFolder.createFile(fileName, csvContent, MimeType.CSV);
    const originalFileUrl = csvFile.getUrl();

    // リクエストペイロード構築
    // jsonData は配列（parsedData）のため、専用キー rows に格納する
    const payload = {
      wholesaler_id:     wholesalerId,
      original_file_url: originalFileUrl,
      rows:              jsonData
    };

    const options = {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response     = UrlFetchApp.fetch(config.postUrl, options);
    const responseCode = response.getResponseCode();
    const rawText      = response.getContentText();
    let responseBody;
    try {
      responseBody = JSON.parse(rawText);
    } catch (_) {
      responseBody = rawText; // 非JSONレスポンスは生テキストのまま保持
    }

    if (responseCode < 200 || responseCode >= 300) {
      throw new Error('BackOffice API error (HTTP ' + responseCode + '): ' + JSON.stringify(responseBody));
    }
    return success_(responseBody);
  } catch (err) {
    throw new Error('sendInvoiceData failed: ' + err.message);
  }
}

// =============================================================================
// 請求一覧取得
// =============================================================================

/**
 * ログインユーザーの請求一覧を BackOffice API から取得する。
 * フロントエンドの home.js から google.script.run 経由で呼ばれる。
 *
 * @returns {{ status: 'success', data: Array<Object> }}
 * @throws {Error} API エラー時
 */
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
// 請求詳細取得
// =============================================================================

/**
 * 指定した請求IDの詳細データを BackOffice API から取得する。
 * フロントエンドの detail ページから google.script.run 経由で呼ばれる。
 *
 * @param {string} invoiceId - 取得対象の請求ID
 * @returns {{ status: 'success', data: Object }}
 * @throws {Error} API エラー時
 */
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
// モックデータ ── BackOffice API 実装後に削除する
//
// ※ フロント側フォールバック（fe_js.html 内の home.js）と同一のデータ形式を維持すること
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

/**
 * スケジュールデータのモックを返す。
 * BackOffice API 実装後に削除すること。
 *
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
 * BackOffice API 実装後に削除すること。
 *
 * @returns {{ status: 'success', data: Array }}
 */
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

// =============================================================================
// テスト用関数 ── 動作確認が終わったら削除してOK
// =============================================================================

/**
 * sendInvoiceData の動作確認用テスト関数。
 * Script Property "ENV" が "development" のときのみ実行可能。
 * GAS エディタから手動で実行して動作を確認する。
 */
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
