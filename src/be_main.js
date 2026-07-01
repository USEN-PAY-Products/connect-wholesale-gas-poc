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

  // LP から ?token=xxx で渡されるセッショントークンを取得（iframe 内ではフラグメントが使えないため）
  const sessionToken = (e && e.parameter && e.parameter.token) || '';

  const template = HtmlService.createTemplateFromFile('fe_index');
  template.isDev = isDev; // fe_index.html で window.__APP_IS_DEV__ として公開
  template.sessionToken = sessionToken; // フロント getSessionToken_() がテンプレート注入値を読む

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
 * HTMLファイルを文字列として読み込む（ネストした include に対応）。
 * fe_index.html 内の <?!= include('fe_xxx'); ?> から呼ばれる。
 *
 * @param {string} filename - 拡張子なしのファイル名（例: 'fe_css'）
 * @returns {string} ファイルの内容文字列
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
