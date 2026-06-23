// =============================================================================
// Assets: 画面で使う静的リソース（ファビコン等）のURLを管理する
//
// 【重要】HtmlOutput.setFaviconUrl() は data URI(base64) を受け付けず、
//   公開HTTPS URL のみ有効（data URI は "この画像形式はサポートされていません"
//   という例外になる）。また GAS には静的ファイルをURLパスで配信する仕組みが
//   無いため、画像は外部に公開ホストする必要がある。
//
// 【この実装の方針】
//   ファビコンは LP（wholesale-portal-lp / S3 + CloudFront 配信）に既に置かれて
//   いるロゴ画像を流用する。LP は src/ 配下をビルドせずそのままのパスで配信する
//   ため、LP の src/assets/images/logo.png は
//       {LP_URL}/assets/images/logo.png
//   で公開されている（dev で HTTP 200 / image/png を確認済み）。
//   ドメインは環境別 Script Property "LP_URL" に追従するため、dev/prod が
//   自動で切り替わる。
//
// 【上書き】個別のURLを使いたい場合は Script Property "FAVICON_URL" を設定すると
//   そちらが最優先される（LP 以外の画像に差し替えたいとき用）。
// =============================================================================

/** LP 上のロゴ画像の、LP_URL からの相対パス（LP の src/assets/images/logo.png に対応） */
const FAVICON_LP_PATH_ = 'assets/images/logo.png';

/**
 * ブラウザのタブに表示するファビコン画像の公開URLを返す。
 *
 * 優先順位:
 *   1. Script Property "FAVICON_URL"（明示指定があれば最優先）
 *   2. LP_URL + '/assets/images/logo.png'（LPのロゴを流用。dev/prod 自動切替）
 *   3. ''（取得不可。doGet 側でファビコン設定をスキップ＝GASデフォルト表示）
 *
 * @returns {string} 公開HTTPS の画像URL。利用不可なら ''（空文字）
 */
function getFaviconUrl_() {
  // 1) 明示設定（FAVICON_URL）があれば最優先
  const explicit = PropertiesService.getScriptProperties().getProperty('FAVICON_URL');
  if (explicit) return explicit;

  // 2) LP のロゴ画像を流用（ドメインは LP_URL に追従＝dev/prod 自動切替）
  try {
    const lpUrl = getConfig_().lpUrl;
    if (lpUrl) {
      return lpUrl.replace(/\/+$/, '') + '/' + FAVICON_LP_PATH_;
    }
  } catch (err) {
    console.warn('[getFaviconUrl_] LP_URL 取得に失敗したためファビコンをスキップします: ' + err);
  }

  // 3) 取得不可
  return '';
}
