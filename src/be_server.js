// =============================================================================
// be_server.js
//
// アカウント情報取得の公開関数を管理する。
// ログイン中の GAS ユーザーのメールアドレスから BQ を直接クエリして取得する。
//
// 公開関数:
//   getAccountInfo() ← フロントから google.script.run 経由で呼ばれる
// =============================================================================

/**
 * BQ からアカウント情報を取得する内部ヘルパー。
 * メールアドレスをキーに wholesaler_user を起点に JOIN。
 * メールの取得優先順: 引数 email > sessionToken の Cache 逆引き > Session.getActiveUser()（組織内フォールバック）。
 * エラー種別は用途で2つに分かれる:
 *   - UNAUTHORIZED:  メール未取得（未ログイン/トークン失効）→ フロントは再ログイン案内
 *   - NOT_REGISTERED: メールは取れたが BQ に未登録 → フロントは登録案内（停止卸は弾かず閲覧可）
 *
 * @param {string} [email] - 認証済みメール。doPost の tokeninfo 検証後に渡される。
 * @param {string} [sessionToken] - セッショントークン。Cache から email を逆引きする。
 * @returns {Object} アカウント情報オブジェクト
 * @throws {Error} BQ クエリ失敗時、メール未取得(UNAUTHORIZED:)、または未登録(NOT_REGISTERED:)
 */
function getServerAccountInfo_(email, sessionToken) {
  if (!email && sessionToken) {
    // サーバー側でも形式/長さを検証（不正値は無視して Session フォールバック）
    if (typeof sessionToken === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionToken)) {
      email = CacheService.getScriptCache().get('shiire_session:' + sessionToken) || '';
    }
  }
  if (!email) {
    email = Session.getActiveUser().getEmail();
  }
  if (!email) {
    logError_('Auth', '認証失敗: メールアドレスを取得できませんでした');
    throw new Error('UNAUTHORIZED: ログイン情報の取得に失敗しました。再度ログインしてください。');
  }

  const accountInfo = fetchAccountInfoByEmail_(email);
  if (!accountInfo) {
    logError_('Auth', '認証失敗: アカウント未登録（BQに該当なし）');
    throw new Error('NOT_REGISTERED: このアカウントは登録されていません。管理者にお問い合わせください。');
  }

  logInfo_('Auth', '認証成功: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id);
  return accountInfo;
}

/**
 * フロントエンドの DOMContentLoaded 時に google.script.run 経由で呼ばれる公開関数。
 * @param {string} [sessionToken] - LP ログイン時に発行されたセッショントークン。
 * @returns {{ status: 'success', data: Object }}
 */
function getAccountInfo(sessionToken) {
  // catch から参照するため try 外で先行宣言（Slack通知コンテキストに使用）
  let accountInfo = null;
  try {
    accountInfo = getServerAccountInfo_('', sessionToken);
    return success_(accountInfo);
  } catch (err) {
    logError_('Auth', 'getAccountInfo', err, {
      wholesalerId: accountInfo && accountInfo.wholesaler_id,
      wholesalerName: accountInfo && accountInfo.wholesaler_name,
      actionLabel: 'アカウント情報取得',
    });
    // UNAUTHORIZED / NOT_REGISTERED はフロントが err.message で認証エラーを判定するためそのまま再throw
    const m = String(err.message || '');
    if (m.startsWith('UNAUTHORIZED:') || m.startsWith('NOT_REGISTERED:')) {
      throw err;
    }
    throw new Error('アカウント情報の取得に失敗しました。ページを再読み込みしてください。');
  }
}

// =============================================================================
// ログアウト: リダイレクト先URL取得
// =============================================================================

/**
 * ログアウト時のリダイレクト先URLを返す。
 * ScriptProperties の LP_URL に ?logout=true パラメータを付与して返却する。
 * フロントエンドから google.script.run.getLogoutUrl() で呼び出される。
 *
 * @returns {{ status: 'success', data: { url: string } }}
 */
function getLogoutUrl() {
  try {
    const { lpUrl } = getConfig_();
    if (!lpUrl) {
      throw new Error('ログアウト先URLが設定されていません。管理者にお問い合わせください。');
    }
    // セキュリティ: https スキームのみ許可（オープンリダイレクト / XSS 防止）
    if (!/^https:\/\//i.test(lpUrl)) {
      logError_('Auth', 'getLogoutUrl: 不正なLP_URL スキーム: ' + lpUrl);
      throw new Error('ログアウト先URLの設定が不正です。管理者にお問い合わせください。');
    }
    const separator = lpUrl.includes('?') ? '&' : '?';
    const logoutUrl = lpUrl + separator + 'logout=true';
    return success_({ url: logoutUrl });
  } catch (err) {
    logError_('Auth', 'getLogoutUrl', err);
    throw new Error('ログアウト処理に失敗しました。ページを再読み込みしてください。');
  }
}

/**
 * ログインページ（LP）のURLを返す。
 * ScriptProperties の LP_URL をそのまま返却する（logout=true は付与しない）。
 * エラー画面の「ログインページに戻る」ボタンから google.script.run.getLoginUrl() で呼び出される。
 * エラー画面はログイン前提なので、LP側で「ログアウトしました」トーストが出ないよう getLogoutUrl とは別関数にしている。
 *
 * @returns {{ status: 'success', data: { url: string } }}
 */
function getLoginUrl() {
  try {
    const { lpUrl } = getConfig_();
    if (!lpUrl) {
      throw new Error('ログインページURLが設定されていません。管理者にお問い合わせください。');
    }
    // セキュリティ: https スキームのみ許可（オープンリダイレクト / XSS 防止）
    if (!/^https:\/\//i.test(lpUrl)) {
      logError_('Auth', 'getLoginUrl: 不正なLP_URL スキーム: ' + lpUrl);
      throw new Error('ログインページURLの設定が不正です。管理者にお問い合わせください。');
    }
    return success_({ url: lpUrl });
  } catch (err) {
    logError_('Auth', 'getLoginUrl', err);
    throw new Error('ログインページへの遷移に失敗しました。ページを再読み込みしてください。');
  }
}

// --- 請求登録・取得系の公開関数は be_invoice.js で定義 ---

