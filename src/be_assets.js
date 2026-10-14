// =============================================================================
// Assets: 画面で使う静的リソース（ファビコン等）のURLを管理する
//
// 【重要】HtmlOutput.setFaviconUrl() は data URI(base64) を受け付けず、
//   公開HTTPS URL のみ有効（data URI は "この画像形式はサポートされていません"
//   という例外になる）。また GAS には静的ファイルをURLパスで配信する仕組みが
//   無いため、画像は外部に公開ホストする必要がある。
//
// 【この実装の方針】
//   Script Property "FAVICON_URL"（https のみ）が設定されている場合のみ使用する。
//   未設定の場合はファビコンなし（GAS デフォルト表示）。
//   LP_URL への依存は廃止（LP は使わない前提）。
// =============================================================================

/**
 * 値が公開HTTPSのURL（"https://" で始まる）かどうかを判定する。
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
 * Script Property "FAVICON_URL" が設定されており https URL の場合のみ返す。
 * 未設定または https 以外の場合は '' を返す（doGet 側でファビコン設定をスキップ＝GASデフォルト表示）。
 *
 * @returns {string} 公開HTTPS の画像URL。利用不可・不正値なら ''（空文字）
 */
function getFaviconUrl_() {
  const explicit = PropertiesService.getScriptProperties().getProperty('FAVICON_URL');
  if (!explicit) return '';
  if (isHttpsUrl_(explicit)) return explicit.trim();
  console.warn('[getFaviconUrl_] FAVICON_URL が https ではないためスキップします: ' + explicit);
  return '';
}
