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
 * 値が公開HTTPSのURL（"https://" で始まる）かどうかを判定する。
 *
 * setFaviconUrl() は data URI を受け付けず例外になり、また http/data/javascript 等の
 * 誤設定は意図しない外部参照（情報漏えい・トラッキング等）につながる。そのため
 * ファビコン関連のURLは公開HTTPSのみ許可し、それ以外はスキップする。
 *
 * @param {*} url - 判定対象（文字列以外は false）
 * @returns {boolean} 前後の空白を除いて "https://" で始まれば true
 */
function isHttpsUrl_(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url.trim());
}

/**
 * ブラウザのタブに表示するファビコン画像の公開URLを返す。
 *
 * 優先順位:
 *   1. Script Property "FAVICON_URL"（明示指定があり、かつ https のとき最優先）
 *   2. LP_URL + '/assets/images/logo.png'（LP_URL が https のときのみ。dev/prod 自動切替）
 *   3. ''（取得不可・不正値。doGet 側でファビコン設定をスキップ＝GASデフォルト表示）
 *
 * 注意: FAVICON_URL / LP_URL とも https 以外（http/data/javascript 等）はスキップする。
 *
 * @returns {string} 公開HTTPS の画像URL。利用不可・不正値なら ''（空文字）
 */
function getFaviconUrl_() {
  // 1) 明示設定（FAVICON_URL）があれば最優先（https のみ許可）
  const explicit = PropertiesService.getScriptProperties().getProperty('FAVICON_URL');
  if (explicit) {
    if (isHttpsUrl_(explicit)) return explicit.trim();
    // http/data/javascript 等の誤設定は setFaviconUrl 例外・意図しない外部参照に
    // つながるためスキップし、LP_URL からの導出にフォールバックする。
    console.warn('[getFaviconUrl_] FAVICON_URL が https ではないためスキップします: ' + explicit);
  }

  // 2) LP のロゴ画像を流用（ドメインは LP_URL に追従＝dev/prod 自動切替。https のみ許可）
  try {
    const lpUrl = getConfig_().lpUrl;
    if (lpUrl) {
      if (!isHttpsUrl_(lpUrl)) {
        console.warn('[getFaviconUrl_] LP_URL が https ではないためファビコンをスキップします: ' + lpUrl);
        return '';
      }
      return lpUrl.trim().replace(/\/+$/, '') + '/' + FAVICON_LP_PATH_;
    }
  } catch (err) {
    console.warn('[getFaviconUrl_] LP_URL 取得に失敗したためファビコンをスキップします: ' + err);
  }

  // 3) 取得不可・不正値
  return '';
}
