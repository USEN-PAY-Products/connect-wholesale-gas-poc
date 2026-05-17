// =============================================================================
// Utils: 共通ユーティリティ
// =============================================================================

/**
 * XSS 対策: HTML 特殊文字をエスケープする
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
