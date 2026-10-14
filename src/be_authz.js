// =============================================================================
// be_authz.js
//
// 認証・認可ヘルパー（BO の Authz 相当）。
// Session.getActiveUser() でメールアドレスを取得し、ALLOWED_DOMAINS / ALLOWED_EMAILS
// に基づいてアクセス可否を判定する。
//
// エラープレフィックス一覧:
//   UNAUTHORIZED:       メール取得不可（未ログイン）
//   FORBIDDEN:          許可リスト外アカウント
//   WHOLESALER_MISSING: wholesalerId 未指定
//   WHOLESALER_INVALID: wholesalerId 形式不正 or 卸が見つからない
//   WHOLESALER_INACTIVE: 卸のステータスが inactive
//   SYSTEM:             ロック取得失敗 等
//
// 依存:
//   be_config.js … getConfig_()
// =============================================================================

/**
 * ログイン中のユーザーのメールアドレスを取得し、許可リストで認可を検証する。
 * 許可リスト（ALLOWED_DOMAINS / ALLOWED_EMAILS）が未設定の場合は全員を許可（PoC 方針 D-9）。
 *
 * @returns {string} 認可済みメールアドレス
 * @throws {Error} UNAUTHORIZED: / FORBIDDEN:
 */
function requireAuthorizedOperator_() {
  let email = '';
  try {
    email = Session.getActiveUser().getEmail() || '';
  } catch (err) {
    throw new Error('UNAUTHORIZED: ユーザーを識別できません。Googleアカウントでアクセスしてください。');
  }
  if (!email) throw new Error('UNAUTHORIZED: ユーザーを識別できません。Googleアカウントでアクセスしてください。');

  const cfg = getConfig_();
  // ドメイン・メールアドレスは大文字小文字を区別しないため、双方を小文字へ正規化して比較する
  const lower = function (v) { return String(v).trim().toLowerCase(); };
  const domain = (email.split('@')[1] || '').toLowerCase();
  const domainOk = cfg.allowedDomains.length === 0 || cfg.allowedDomains.map(lower).indexOf(domain) !== -1;
  const emailOk  = cfg.allowedEmails.length  === 0 || cfg.allowedEmails.map(lower).indexOf(email.toLowerCase()) !== -1;
  if (!domainOk || !emailOk) throw new Error('FORBIDDEN: このアカウントにはアクセス権がありません。');
  return email;
}
