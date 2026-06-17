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
    .setTitle('仕入れコネクト')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
