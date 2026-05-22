// =============================================================================
// be_server.js
//
// アカウント情報取得の公開関数を管理する。
// ログイン中の GAS ユーザーのメールアドレスから BQ を直接クエリして取得する。
//
// 公開関数:
//   getAccountInfo() ← フロントから google.script.run 経由で呼ばれる
// =============================================================================

/** Drive保存・BQ書き込みのスタブ。false = 本番動作。 */
const STUB_MODE = false;

// --- 以下はスタブ定数（削除済み）---
// STUB_ACCOUNT_INFO は BQ 直接取得に移行したため不要

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
    throw new Error('UNAUTHORIZED: ログインユーザーのメールアドレスを取得できませんでした。');
  }

  const accountInfo = fetchAccountInfoByEmail_(email);
  if (!accountInfo) {
    throw new Error('UNAUTHORIZED: アカウント情報が見つかりませんでした。管理者にお問い合わせください。');
  }

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
    throw new Error('getAccountInfo failed: ' + err.message);
  }
}

// --- 請求登録・取得系の公開関数は be_invoice.js で定義 ---

