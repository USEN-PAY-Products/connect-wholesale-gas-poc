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
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ status: 'error', message: 'リクエストボディが空です。' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse_({ status: 'error', message: 'リクエストの形式が不正です。JSON 形式で送信してください。' });
    }

    var idToken = body.token;
    if (!idToken) {
      return jsonResponse_({ status: 'error', message: 'トークンが送信されていません。' });
    }

    // ── Google tokeninfo API でトークンを検証 ──
    var verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken;
    var verifyRes = UrlFetchApp.fetch(verifyUrl, { muteHttpExceptions: true });
    if (verifyRes.getResponseCode() !== 200) {
      return jsonResponse_({ status: 'error', message: '無効なトークンです。再度ログインしてください。' });
    }

    var tokenInfo = JSON.parse(verifyRes.getContentText());

    // ── aud（クライアントID）の一致を検証 ──
    var expectedClientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
    if (!expectedClientId) {
      Logger.log('[doPost] GOOGLE_CLIENT_ID がスクリプトプロパティに未設定です。');
      return jsonResponse_({ status: 'error', message: 'サーバー設定エラーです。管理者に連絡してください。' });
    }
    if (tokenInfo.aud !== expectedClientId) {
      Logger.log('[doPost] aud 不一致: expected=' + expectedClientId + ', got=' + tokenInfo.aud);
      return jsonResponse_({ status: 'error', message: '無効なトークンです。再度ログインしてください。' });
    }

    // ── メールアドレスの検証済みチェック ──
    if (String(tokenInfo.email_verified) !== 'true') {
      return jsonResponse_({ status: 'error', message: 'メールアドレスが未確認のアカウントではログインできません。' });
    }

    var email = tokenInfo.email;
    if (!email) {
      return jsonResponse_({ status: 'error', message: 'トークンからメールアドレスを取得できませんでした。' });
    }

    // ── BQ でアカウント照合（既存関数を利用） ──
    var accountInfo = fetchAccountInfoByEmail_(email);
    if (!accountInfo) {
      return jsonResponse_({
        status: 'fail',
        message: 'このアカウントは登録されていません。\n登録済みのGoogleアカウントで再度ログインしてください。',
      });
    }

    return jsonResponse_({ status: 'success', userData: accountInfo });

  } catch (err) {
    Logger.log('[doPost] エラー: ' + err.message);
    return jsonResponse_({ status: 'error', message: '認証処理中にエラーが発生しました。' });
  }
}

/**
 * JSON レスポンスを生成するヘルパー。
 * GAS の doPost は自動リダイレクト経由で応答するため、
 * カスタム CORS ヘッダは不要（フロント側は Content-Type: text/plain で送信）。
 * @param {Object} obj - レスポンスオブジェクト
 * @returns {TextOutput}
 */
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
