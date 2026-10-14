// =============================================================================
// be_server.js
//
// アカウント情報取得の公開関数を管理する。
// BO の代行運用（コンテキストスイッチ）方式に対応。
// wholesalerId を引数として受け取り、BQ を直接クエリして取得する。
//
// 公開関数:
//   getAccountInfo(wholesalerId)  ← フロントから google.script.run 経由で呼ばれる
//   listWholesalers()             ← ヘッダーの卸切替一覧用
// =============================================================================

/**
 * 指定された wholesalerId のアカウント情報を BQ から取得する内部ヘルパー。
 * 認証・認可・形式検証・卸の実在確認・操作者の wholesaler_user 特定/自動登録を行う。
 *
 * @param {string|number} wholesalerId - 操作対象の卸ID（getAccountInfo から渡される）
 * @returns {Object} アカウント情報オブジェクト（operator_email が付加される）
 * @throws {Error} UNAUTHORIZED: / FORBIDDEN: / WHOLESALER_MISSING: / WHOLESALER_INVALID: / WHOLESALER_INACTIVE:
 */
function getServerAccountInfo_(wholesalerId) {
  const operatorEmail = requireAuthorizedOperator_();              // ① 認証・認可

  const idStr = String(wholesalerId == null ? '' : wholesalerId).trim();
  if (!idStr)                   throw new Error('WHOLESALER_MISSING: 卸が指定されていません。');
  if (!/^\d{1,15}$/.test(idStr)) throw new Error('WHOLESALER_INVALID: 卸IDの形式が不正です。'); // ② 形式検証

  // 15桁以内に制限（Number.MAX_SAFE_INTEGER 未満が保証される）。
  // 既存コードが Number(wholesaler_id) 変換を多用するため、精度落ちを入口で防ぐ。
  const accountInfo = fetchAccountInfoByWholesalerId_(Number(idStr), operatorEmail); // ③ 卸の実在確認 + 操作者の wholesaler_user 特定/自動登録
  if (!accountInfo) throw new Error('WHOLESALER_INVALID: 指定された卸が見つかりません。');

  accountInfo.operator_email = operatorEmail;                       // ④ ログ・Slack・監査用に付与
  logInfo_('Auth', '認証成功: wholesaler_id=' + accountInfo.wholesaler_id +
                   ', operator=' + operatorEmail + ', account_id=' + accountInfo.wholesaler_user_id);
  return accountInfo;
}

/**
 * フロントエンドの DOMContentLoaded 時に google.script.run 経由で呼ばれる公開関数。
 * @param {string|number} wholesalerId - 操作対象の卸ID（doGet がテンプレート注入した値）
 * @returns {{ status: 'success', data: Object }}
 */
function getAccountInfo(wholesalerId) {
  let operatorEmail_ = '';
  try { operatorEmail_ = Session.getActiveUser().getEmail() || ''; } catch (e) { /* 取得不可でもログのみのため継続 */ }
  try {
    return success_(getServerAccountInfo_(wholesalerId));
  } catch (err) {
    // 認証/指定系エラーは err.message をそのままフロントへ（プレフィックスで画面を出し分け）
    const m = String(err.message || '');
    // SYSTEM: はロック取得失敗など利用者に伝えるべき文言のため、他の認証系と同様にそのまま返す
    if (/^(UNAUTHORIZED|FORBIDDEN|WHOLESALER_MISSING|WHOLESALER_INVALID|WHOLESALER_INACTIVE|SYSTEM):/.test(m)) throw err;
    logError_('Auth', 'getAccountInfo', err, { actionLabel: 'アカウント情報取得', operatorEmail: operatorEmail_ });
    throw new Error('アカウント情報の取得に失敗しました。ページを再読み込みしてください。');
  }
}

/**
 * ヘッダーの卸切替一覧用。認可のみ通せば呼べる（卸未選択でも使えるため）。
 * 呼び出し時に操作者付きの監査ログを記録する。
 *
 * @returns {{ status: 'success', data: Array<{wholesaler_id, wholesaler_name, wholesaler_status}> }}
 */
function listWholesalers() {
  const operatorEmail = requireAuthorizedOperator_();
  logInfo_('Auth', 'listWholesalers: operator=' + operatorEmail); // 全卸一覧の参照を監査ログに残す
  return success_(fetchWholesalerList_());
}

// --- 請求登録・取得系の公開関数は be_invoice.js で定義 ---
