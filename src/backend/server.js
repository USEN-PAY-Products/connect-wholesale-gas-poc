// =============================================================================
// Config: BackOffice API URLs (centrally managed)
// =============================================================================
var BACKOFFICE_API_POST_URL = 'https://httpbin.org/post';
var BACKOFFICE_API_GET_URL  = 'https://httpbin.org/get';

// Google Drive root folder ID for audit trail storage
var DRIVE_ROOT_FOLDER_ID = '1rGvUwmPpkxTsYN2tRIo-UM4PnKAnx5Ro';

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
  return Session.getActiveUser().getEmail();
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
    var wholesalerId = _getWholesalerId();
    var now = new Date();

    // Save CSV audit trail to Drive
    var rootFolder      = DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);
    var userFolder      = _getOrCreateSubFolder(rootFolder, wholesalerId);
    var monthFolder     = _getOrCreateSubFolder(userFolder, _formatYearMonth(now));
    var fileName        = _formatTimestamp(now) + '_original.csv';
    var csvFile         = monthFolder.createFile(fileName, csvContent, MimeType.CSV);
    var originalFileUrl = csvFile.getUrl();

    // Build payload
    var payload = Object.assign({}, jsonData, {
      wholesaler_id:     wholesalerId,
      original_file_url: originalFileUrl
    });

    var options = {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response     = UrlFetchApp.fetch(BACKOFFICE_API_POST_URL, options);
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
    var wholesalerId = _getWholesalerId();
    var url = BACKOFFICE_API_GET_URL + '?wholesaler_id=' + encodeURIComponent(wholesalerId);

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
    var wholesalerId = _getWholesalerId();
    var url =
      BACKOFFICE_API_GET_URL +
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


// --- テスト用関数（動作確認が終わったら消してOK） ---
function testSendInvoice() {
  // フロントエンドから送られてくるであろう「仮のデータ」を用意
  const dummyJson = { amount: 1000, memo: "テスト請求" };
  const dummyCsv = "加盟店コード,金額\nA001,1000";

  // 先ほど作った関数を直接呼び出す
  const result = sendInvoiceData(dummyJson, dummyCsv);
  
  // 結果をログに出力
  console.log("テスト結果:", result);
}