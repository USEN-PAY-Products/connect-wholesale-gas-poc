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
 * 1. requireAuthorizedOperator_() で認可チェック（UNAUTHORIZED/FORBIDDEN→403）。
 * 2. wholesalerId をクエリから取得し、テンプレートへ注入。
 * 3. operatorEmail / webAppUrl / backOfficeUrl を注入。
 */
function doGet(e) {
  // ── 認可 ─────────────────────────────────────────────────────────────────
  let operatorEmail = '';
  try {
    operatorEmail = requireAuthorizedOperator_();
  } catch (err) {
    // 403 にするのは UNAUTHORIZED / FORBIDDEN のみ。設定不備は GAS のエラー画面＋ログに出す
    if (/^(UNAUTHORIZED|FORBIDDEN):/.test(String(err.message || ''))) {
      return forbiddenPage_(err);
    }
    logError_('Auth', 'doGet', err, { actionLabel: '起動' });
    throw err;
  }

  // ── wholesalerId の取得（不正値は未指定扱い）───────────────────────────
  const raw = String((e && e.parameter && e.parameter.wholesalerId) || '').trim();
  // 不正な指定を未選択状態に丸めず、サーバー検証で WHOLESALER_INVALID とする。
  const wholesalerId = raw === '' ? '' : (/^\d{1,15}$/.test(raw) ? raw : '__invalid__');

  // ── 環境判定 ─────────────────────────────────────────────────────────────
  let isDev = false;
  try {
    isDev = getConfig_().env === 'development';
  } catch (err) {
    console.warn('[doGet] 環境判定に失敗したため本番扱いにします: ' + err);
  }

  const template = HtmlService.createTemplateFromFile('fe_index');
  template.isDev         = isDev;
  template.wholesalerId  = wholesalerId;
  template.operatorEmail = operatorEmail;
  const config = getConfig_();
  template.webAppUrl     = config.webAppUrl || ScriptApp.getService().getUrl(); // 卸切替の遷移先
  template.backOfficeUrl = config.backOfficeUrl;                                // https のみ許可済み

  const output = template
    .evaluate()
    .setTitle(isDev ? '仕入れコネクト(Dev)' : '仕入れコネクト')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');

  // ── ファビコン設定（任意）───────────────────────────────────────────────
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
 * 403 Forbidden ページを返す。
 * UNAUTHORIZED / FORBIDDEN どちらも同じ 403 扱い（理由は表示しない）。
 *
 * @param {Error} err
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function forbiddenPage_(err) {
  console.warn('[doGet] 403 Forbidden: ' + (err && err.message));
  return HtmlService.createHtmlOutput(
    '<h2>403 Forbidden</h2><p>アクセス権がありません。</p>'
  );
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
