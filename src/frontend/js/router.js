// =============================================================================
// Router: ハッシュベースの簡易 SPA ルーター
// =============================================================================

/**
 * 登録済みページのマップ。
 * key   : URL ハッシュ（'#upload' など）
 * value : そのページのルート要素の id
 */
const ROUTES = {
  '#home':    'pageHome',
  '#upload':  'pageUpload',
  '#confirm': 'pageConfirm',
  '#detail':  'pageDetail',
};

/** デフォルトルート */
const DEFAULT_ROUTE = '#home';

/**
 * location.hash から { baseHash, params } を取り出す。
 * 例: '#detail?invoiceId=b001' → { baseHash: '#detail', params: URLSearchParams }
 * @returns {{ baseHash: string, params: URLSearchParams }}
 */
function parseHash() {
  const raw = location.hash || DEFAULT_ROUTE;
  const sepIdx = raw.indexOf('?');
  if (sepIdx === -1) {
    return { baseHash: raw, params: new URLSearchParams() };
  }
  return {
    baseHash: raw.slice(0, sepIdx),
    params:   new URLSearchParams(raw.slice(sepIdx + 1)),
  };
}

/**
 * 現在のハッシュに対応するページだけ表示し、他を非表示にする。
 */
function navigate() {
  const { baseHash, params } = parseHash();
  const targetId = ROUTES[baseHash] || ROUTES[DEFAULT_ROUTE];

  Object.values(ROUTES).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== targetId);
  });

  if (targetId === 'pageHome') {
    initHomePage();
  }

  if (targetId === 'pageConfirm') {
    renderConfirmPage();
  }

  if (targetId === 'pageDetail') {
    const invoiceId = params.get('invoiceId') || null;
    console.log('[router] 詳細画面: invoiceId =', invoiceId);
    // TODO: initDetailPage(invoiceId) を呼ぶ
  }

  console.log(`[router] navigated to ${baseHash} -> #${targetId}`);
}

// ハッシュ変化時・初回ロード時にルーティング実行
window.addEventListener('hashchange', navigate);
window.addEventListener('DOMContentLoaded', navigate);
