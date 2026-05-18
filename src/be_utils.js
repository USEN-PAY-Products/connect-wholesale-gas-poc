// =============================================================================
// Utils: バックエンド共通ユーティリティ
//
// すべての be_*.js から呼び出せる共通ヘルパー関数を管理する。
// GAS はプロジェクト内の全ファイルをグローバルスコープで共有するため、
// このファイルの関数はプロジェクト内のどこからでも利用可能。
// =============================================================================

// =============================================================================
// レスポンス整形
// =============================================================================

/**
 * 成功レスポンスを生成する。
 * @param {*} data - レスポンスに含めるデータ
 * @returns {{ status: 'success', data: * }}
 */
function success_(data) {
  return { status: 'success', data: data };
}

/**
 * エラーレスポンスを生成する。
 * @param {string} message - エラーメッセージ
 * @param {*} [data] - 追加情報（省略可）
 * @returns {{ status: 'error', message: string, data: * }}
 */
function error_(message, data) {
  return { status: 'error', message: message, data: data || null };
}

// =============================================================================
// ユーザー情報
// =============================================================================

/**
 * 実行ユーザーのメールアドレスのローカルパート（@より前）を卸IDとして返す。
 * メールアドレス全文をログ・レスポンスに含めないための安全策。
 *
 * @returns {string} 卸業者ID（メールのローカルパート）
 * @throws {Error} メールアドレスが取得できない場合
 */
function getWholesalerId_() {
  const email = Session.getActiveUser().getEmail();
  const atIndex = email.indexOf('@');
  if (atIndex === -1) throw new Error('ユーザーのメールアドレスが取得できませんでした');
  return email.slice(0, atIndex);
}

// =============================================================================
// Google Drive ヘルパー
// =============================================================================

/**
 * 指定フォルダ内に同名サブフォルダがあれば取得し、なければ新規作成して返す。
 *
 * @param {GoogleAppsScript.Drive.Folder} parentFolder - 親フォルダ
 * @param {string} name - サブフォルダ名
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function getOrCreateSubFolder_(parentFolder, name) {
  const folders = parentFolder.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(name);
}

// =============================================================================
// 日付フォーマット
// =============================================================================

/**
 * Date オブジェクトを "YYYYMMDD_HHmmss" 形式の文字列に変換する。
 * ファイル名のタイムスタンプ部分に使用する。
 *
 * @param {Date} date
 * @returns {string} 例: "20260518_143022"
 */
function formatTimestamp_(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '_' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/**
 * Date オブジェクトを "YYYYMM" 形式の文字列に変換する。
 * Drive フォルダの月別管理に使用する。
 *
 * @param {Date} date
 * @returns {string} 例: "202605"
 */
function formatYearMonth_(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + pad(date.getMonth() + 1);
}
