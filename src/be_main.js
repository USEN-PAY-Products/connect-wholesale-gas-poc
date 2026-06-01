// =============================================================================
// Main: エントリーポイント
//
// GAS Webアプリのエントリーポイントと、HTMLテンプレートの include ヘルパーを管理する。
// ルーティングや画面制御はフロントエンド側のハッシュルーターが担う。
// =============================================================================

/**
 * GAS Webアプリのエントリーポイント。
 * fe_index.html をテンプレートとして評価し、HTMLページを返す。
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('fe_index')
    .evaluate()
    .setTitle('Shiire System')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 外部フロント（AWS ログインページ等）からの POST リクエストを処理する。
 * Google ID トークンを受け取り、サーバー側で検証後、BQ でアカウント照合を行う。
 *
 * リクエスト:  { "token": "<Google ID トークン>" }
 * レスポンス:
 *   成功時: { status: "success", userData: {...} }
 *   未登録: { status: "fail",    message: "..." }
 *   エラー: { status: "error",   message: "..." }
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var idToken = body.token;
    if (!idToken) {
      return _jsonResponse({ status: 'error', message: 'トークンが送信されていません。' });
    }

    // ── Google tokeninfo API でトークンを検証 ──
    var verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken;
    var verifyRes = UrlFetchApp.fetch(verifyUrl, { muteHttpExceptions: true });
    if (verifyRes.getResponseCode() !== 200) {
      return _jsonResponse({ status: 'error', message: '無効なトークンです。再度ログインしてください。' });
    }

    var tokenInfo = JSON.parse(verifyRes.getContentText());
    var email = tokenInfo.email;
    if (!email) {
      return _jsonResponse({ status: 'error', message: 'トークンからメールアドレスを取得できませんでした。' });
    }

    // ── BQ でアカウント照合（既存関数を利用） ──
    var accountInfo = fetchAccountInfoByEmail_(email);
    if (!accountInfo) {
      return _jsonResponse({
        status: 'fail',
        message: 'このアカウントは登録されていません。\n登録済みのGoogleアカウントで再度ログインしてください。',
      });
    }

    return _jsonResponse({ status: 'success', userData: accountInfo });

  } catch (err) {
    Logger.log('[doPost] エラー: ' + err.message);
    return _jsonResponse({ status: 'error', message: '認証処理中にエラーが発生しました。' });
  }
}

/**
 * CORS 対応の JSON レスポンスを生成するヘルパー。
 * @param {Object} obj - レスポンスオブジェクト
 * @returns {TextOutput}
 */
function _jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * HTMLファイルを文字列として読み込む（ネストした include に対応）。
 * fe_index.html 内の <?!= include('fe_xxx'); ?> から呼ばれる。
 *
 * @param {string} filename - 拡張子なしのファイル名（例: 'fe_css'）
 * @returns {string} ファイルの内容文字列
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
