// =============================================================================
// be_auth.js
//
// 外部アカウント認証（IDトークン doPost 方式）を管理する。
// LP（外部ドメイン）から Google ID トークンを受け取り、tokeninfo API で検証して
// BQ 照合→セッショントークン発行を行うエンドポイント。
//
// 公開関数:
//   doPost(e) ← GAS Web アプリの POST エンドポイント（LP から呼ばれる）
// =============================================================================

/**
 * 外部（LP）からの POST ログインエンドポイント。
 * フロントから Google ID トークンを受け取り、tokeninfo API で検証して
 * メールを抽出→aud 照合→BQ 照合→セッショントークンを Cache に保存して返す。
 *
 * 受け取り形式（CORS 回避のため Content-Type は text/plain を推奨）:
 *   1. JSON 文字列  {"token":"<IDトークン>"}（推奨）
 *   2. 純テキスト    "<IDトークン>" のみ（JSON でない場合はトークン本体とみなす）
 * 返却は CORS 回避のため ContentService(JSON)。
 * @param {GoogleAppsScript.Events.DoPost} e
 * @returns {GoogleAppsScript.Content.TextOutput} JSON
 */
function doPost(e) {
  // catch から参照するため try 外で先行宣言（Slack通知コンテキストに使用）
  let accountInfo = null;
  try {
    const contents = (e && e.postData && e.postData.contents) || '';
    let idToken = '';
    try {
      idToken = JSON.parse(contents).token; // {"token":"..."} 形式
    } catch (_) {
      idToken = contents.trim();             // 純テキストのトークン本体
    }
    if (!idToken) throw new Error('token がありません');

    const { oauthClientId } = getConfig_();
    if (!oauthClientId) throw new Error('OAUTH_CLIENT_ID が未設定です');

    const resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('token検証失敗');
    const info = JSON.parse(resp.getContentText());
    if (info.aud !== oauthClientId) throw new Error('aud mismatch');
    if (info.email_verified !== 'true' && info.email_verified !== true) throw new Error('email未検証');
    const email = info.email;
    if (!email) throw new Error('emailなし');

    accountInfo = getServerAccountInfo_(email);
    const sessionToken = Utilities.getUuid().replace(/-/g, '');
    CacheService.getScriptCache().put('shiire_session:' + sessionToken, email, 21600); // 6h
    logInfo_('Auth', 'doPost認証成功: wholesaler_id=' + accountInfo.wholesaler_id);
    return jsonOutput_({ status: 'success', sessionToken: sessionToken, data: accountInfo });
  } catch (err) {
    logError_('Auth', 'doPost', err, {
      wholesalerId: accountInfo && accountInfo.wholesaler_id,
      wholesalerName: accountInfo && accountInfo.wholesaler_name,
      actionLabel: '外部ログイン認証',
    });
    const msg = String(err.message || '');
    if (msg.startsWith('NOT_REGISTERED:')) {
      // BQ に未登録 → 専用メッセージで区別
      return jsonOutput_({ status: 'not_registered', message: 'このアカウントは登録されていません。管理者にお問い合わせください。' });
    }
    // token 検証失敗・aud mismatch・email未検証 等 → 一般的な認証失敗
    return jsonOutput_({ status: 'fail', message: '認証に失敗しました。再度ログインしてください。', debug: msg });
  }
}

/** JSON を ContentService で返すヘルパー。 */
function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
