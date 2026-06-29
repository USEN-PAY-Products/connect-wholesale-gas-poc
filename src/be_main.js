// =============================================================================
// Main: エントリーポイント
//
// GAS Webアプリのエントリーポイントと、HTMLテンプレートの include ヘルパーを管理する。
// ルーティングや画面制御はフロントエンド側のハッシュルーターが担う。
// =============================================================================

/**
 * GAS Webアプリのエントリーポイント。
 * fe_index.html をテンプレートとして評価し、HTMLページを返す。
 *
 * 開発環境（ENV=development）のときだけタブタイトルとヘッダーのサービス名に
 * "(Dev)" を付与する（ヘッダー側の付与は fe_js_common.html が window.__APP_IS_DEV__ を参照）。
 */
function doGet(e) {
  // 環境判定は既存ヘルパー getConfig_() を再利用する。
  // 必須プロパティ未設定で throw しても画面表示を止めないよう、本番扱いにフォールバックする。
  let isDev = false;
  try {
    isDev = getConfig_().env === 'development';
  } catch (err) {
    console.warn('[doGet] 環境判定に失敗したため本番扱いにします: ' + err);
  }

  const template = HtmlService.createTemplateFromFile('fe_index');
  template.isDev = isDev; // fe_index.html で window.__APP_IS_DEV__ として公開

  // LP から ?token= で渡されたセッショントークンをフロントへ渡す（外部アカウント認証用）。
  // トークンは英数字・アンダースコア・ハイフンのみ許可し XSS を防ぐ。未指定時は空（組織内は Session フォールバック）。
  let sessionToken = '';
  try {
    const raw = (e && e.parameter && e.parameter.token) || '';
    if (/^[A-Za-z0-9_-]{1,128}$/.test(raw)) sessionToken = raw;
  } catch (err) {
    console.warn('[doGet] token の取得に失敗したためスキップします: ' + err);
  }
  template.sessionToken = sessionToken; // fe_index.html で window.__SESSION_TOKEN__ として公開

  const output = template
    .evaluate()
    .setTitle(isDev ? '仕入れコネクト(Dev)' : '仕入れコネクト')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');

  // ファビコン設定（任意）。
  // 注意: setFaviconUrl は data URI(base64) を受け付けず例外になるため、
  //       公開HTTPS URL（ログイン不要で画像が直接返るもの）のみ指定する。
  //       設定失敗で画面表示を止めないよう try/catch でガードする。
  const faviconUrl = getFaviconUrl_();
  if (faviconUrl) {
    try {
      output.setFaviconUrl(faviconUrl);
    } catch (err) {
      console.warn('[doGet] ファビコン設定に失敗したためスキップします: ' + err);
    }
  }

  return output;
}

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

    const accountInfo = getServerAccountInfo_(email);
    const sessionToken = Utilities.getUuid().replace(/-/g, '');
    CacheService.getScriptCache().put('shiire_session:' + sessionToken, email, 21600); // 6h
    logInfo_('Auth', 'doPost認証成功: wholesaler_id=' + accountInfo.wholesaler_id);
    return jsonOutput_({ status: 'success', sessionToken: sessionToken, data: accountInfo });
  } catch (err) {
    logError_('Auth', 'doPost', err);
    return jsonOutput_({ status: 'fail', message: 'このアカウントは登録されていません。' });
  }
}

/** JSON を ContentService で返すヘルパー。 */
function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
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
