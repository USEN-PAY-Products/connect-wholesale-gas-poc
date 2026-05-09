// =============================================================================
// Private utility helpers
// =============================================================================

function _success(data) {
  return { status: 'success', data: data };
}

function _error(message, data) {
  return { status: 'error', message: message, data: data || null };
}

function _getWholesalerId() {
  var email = Session.getActiveUser().getEmail();
  var atIndex = email.indexOf('@');
  if (atIndex === -1) throw new Error('ユーザーのメールアドレスが取得できませんでした');
  // ローカルパート（@より前）を卸IDとして使用し、個人メールアドレス全文の外部漏洩を避ける
  return email.slice(0, atIndex);
}

function _getOrCreateSubFolder(parentFolder, name) {
  var folders = parentFolder.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(name);
}

function _formatTimestamp(date) {
  var pad = function (n) { return String(n).padStart(2, '0'); };
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

function _formatYearMonth(date) {
  var pad = function (n) { return String(n).padStart(2, '0'); };
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
    var config = _getConfig();
    var wholesalerId = _getWholesalerId();
    var now = new Date();

    // Save CSV audit trail to Drive
    var rootFolder      = DriveApp.getFolderById(config.driveFolderId);
    var userFolder      = _getOrCreateSubFolder(rootFolder, wholesalerId);
    var monthFolder     = _getOrCreateSubFolder(userFolder, _formatYearMonth(now));
    var fileName        = _formatTimestamp(now) + '_original.csv';
    var csvFile         = monthFolder.createFile(fileName, csvContent, MimeType.CSV);
    var originalFileUrl = csvFile.getUrl();

    // Build payload
    // jsonData は配列（parsedData）のため、専用キー rows に入れてマージする
    var payload = {
      wholesaler_id:     wholesalerId,
      original_file_url: originalFileUrl,
      rows:              jsonData
    };

    var options = {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response     = UrlFetchApp.fetch(config.postUrl, options);
    var responseCode = response.getResponseCode();
    var responseBody = JSON.parse(response.getContentText());

    if (responseCode < 200 || responseCode >= 300) {
      return _error('BackOffice API error (HTTP ' + responseCode + ')', responseBody);
    }
    return _success(responseBody);
  } catch (err) {
    return _error('sendInvoiceData failed: ' + err.message);
  }
}

// =============================================================================
// 3. fetchInvoices
// =============================================================================

function fetchInvoices() {
  try {
    var config = _getConfig();
    var wholesalerId = _getWholesalerId();
    var url = config.getUrl + '?wholesaler_id=' + encodeURIComponent(wholesalerId);

    var response     = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    var responseCode = response.getResponseCode();
    var responseBody = JSON.parse(response.getContentText());

    if (responseCode < 200 || responseCode >= 300) {
      return _error('BackOffice API error (HTTP ' + responseCode + ')', responseBody);
    }
    return _success(responseBody);
  } catch (err) {
    return _error('fetchInvoices failed: ' + err.message);
  }
}

// =============================================================================
// 4. fetchInvoiceDetail
// =============================================================================

function fetchInvoiceDetail(invoiceId) {
  try {
    var config = _getConfig();
    var wholesalerId = _getWholesalerId();
    var url =
      config.getUrl +
      '?invoice_id='    + encodeURIComponent(invoiceId) +
      '&wholesaler_id=' + encodeURIComponent(wholesalerId);

    var response     = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    var responseCode = response.getResponseCode();
    var responseBody = JSON.parse(response.getContentText());

    if (responseCode < 200 || responseCode >= 300) {
      return _error('BackOffice API error (HTTP ' + responseCode + ')', responseBody);
    }
    return _success(responseBody);
  } catch (err) {
    return _error('fetchInvoiceDetail failed: ' + err.message);
  }
}


// --- Script Propertiesセットアップヘルパー・テスト用関数は config.js に移動済み ---

// --- テスト用関数（動作確認が終わったら消してOK） ---
// Script Property "ENV" が "development" のときのみ実行可能にする
function testSendInvoice() {
  var env = PropertiesService.getScriptProperties().getProperty('ENV');
  if (env !== 'development') {
    throw new Error('testSendInvoice() は development 環境でのみ実行できます (ENV=' + env + ')');
  }
  const dummyJson = { amount: 1000, memo: 'テスト請求' };
  const dummyCsv = '加盟店コード,金額\nA001,1000';
  const result = sendInvoiceData(dummyJson, dummyCsv);
  console.log('テスト結果:', result);
}