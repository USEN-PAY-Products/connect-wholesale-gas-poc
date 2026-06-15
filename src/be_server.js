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
 * ログイン中の GAS ユーザーのメールアドレスをキーに wholesaler_user を起点に JOIN。
 * 対応ユーザーがない・削除済み・卸が非アクティブな場合は UNAUTHORIZED エラーをthrowする。
 *
 * @returns {Object} アカウント情報オブジェクト
 * @throws {Error} BQ クエリ失敗時、または対応ユーザーが見つからない場合
 */
function getServerAccountInfo_() {
  const email = Session.getActiveUser().getEmail();
  if (!email) {
    logError_('Auth', '認証失敗: メールアドレスを取得できませんでした');
    throw new Error('UNAUTHORIZED: ログイン情報の取得に失敗しました。再度ログインしてください。');
  }

  const accountInfo = fetchAccountInfoByEmail_(email);
  if (!accountInfo) {
    logError_('Auth', '認証失敗: アカウント情報が見つかりません');
    throw new Error('UNAUTHORIZED: アカウント情報が見つかりませんでした。管理者にお問い合わせください。');
  }

  logInfo_('Auth', '認証成功: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id);
  return accountInfo;
}

/**
 * フロントエンドの DOMContentLoaded 時に google.script.run 経由で呼ばれる公開関数。
 * @returns {{ status: 'success', data: Object }}
 */
function getAccountInfo() {
  try {
    return success_(getServerAccountInfo_());
  } catch (err) {
    logError_('Auth', 'getAccountInfo', err);
    // UNAUTHORIZED はフロントが err.message で認証エラーを判定するためそのまま再throw
    if (String(err.message || '').startsWith('UNAUTHORIZED:')) {
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

// --- 請求登録・取得系の公開関数は be_invoice.js で定義 ---

