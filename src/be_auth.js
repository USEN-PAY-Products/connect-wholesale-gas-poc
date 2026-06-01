// =============================================================================
// be_auth.js
//
// 外部フロント（AWS ログインページ等）からの認証リクエストを処理する。
// Google ID トークンの検証と BQ アカウント照合を行い、JSON レスポンスを返す。
//
// 依存: db_bq_query.js（fetchAccountInfoByEmail_）
//       be_config.js（getConfig_） ※ GOOGLE_CLIENT_ID の取得
//
// 公開関数:
//   doPost(e)  ← GAS ウェブアプリの POST エントリーポイント
// =============================================================================

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

    // ── aud（クライアントID）の一致を検証 ──
    var expectedClientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
    if (expectedClientId && tokenInfo.aud !== expectedClientId) {
      Logger.log('[doPost] aud 不一致: expected=' + expectedClientId + ', got=' + tokenInfo.aud);
      return _jsonResponse({ status: 'error', message: '無効なトークンです。再度ログインしてください。' });
    }

    // ── メールアドレスの検証済みチェック ──
    if (String(tokenInfo.email_verified) !== 'true') {
      return _jsonResponse({ status: 'error', message: 'メールアドレスが未確認のアカウントではログインできません。' });
    }

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
