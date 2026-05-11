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
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Shiire System')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// =============================================================================
// 2. sendInvoiceData
// =============================================================================

function sendInvoiceData(jsonData, csvContent) {
  try {
    const config = getConfig_();
    const wholesalerId = getWholesalerId_();
    const now = new Date();

    // Save CSV audit trail to Drive
    const rootFolder      = DriveApp.getFolderById(config.driveFolderId);
    const userFolder      = getOrCreateSubFolder_(rootFolder, wholesalerId);
    const monthFolder     = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName        = formatTimestamp_(now) + '_original.csv';
    const csvFile         = monthFolder.createFile(fileName, csvContent, MimeType.CSV);
    const originalFileUrl = csvFile.getUrl();

    // Build payload
    // jsonData は配列（parsedData）のため、専用キー rows に入れてマージする
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