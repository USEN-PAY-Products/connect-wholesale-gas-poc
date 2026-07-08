// =============================================================================
// Utils: バックエンド共通ユーティリティ
//
// すべての be_*.js から呼び出せる共通ヘルパー関数を管理する。
// GAS はプロジェクト内の全ファイルをグローバルスコープで共有するため、
// このファイルの関数はプロジェクト内のどこからでも利用可能。
// =============================================================================

// =============================================================================
// ログ出力
// =============================================================================

/** ログメッセージの最大文字数 */
const LOG_MAX_LENGTH_ = 1000;

/**
 * ログメッセージをサニタイズする（改行エスケープ＋長さ上限トリム）。
 * @param {string} msg
 * @returns {string}
 */
function sanitizeLogMessage_(msg) {
  const escaped = String(msg).replace(/\r?\n/g, '\\n').replace(/\r/g, '\\r');
  if (escaped.length <= LOG_MAX_LENGTH_) return escaped;
  return escaped.slice(0, LOG_MAX_LENGTH_) + '...(truncated)';
}

/**
 * INFOレベルのログを出力する。
 * @param {string} tag - ログのカテゴリタグ (例: "Invoice", "Auth", "BQ")
 * @param {string} message - ログメッセージ
 */
function logInfo_(tag, message) {
  Logger.log('[INFO][' + tag + '] ' + sanitizeLogMessage_(message));
}

/**
 * ERRORレベルのログを出力する。
 * Cloud Logging への記録（Logger.log）は無条件・最優先で必ず実行し、
 * その後にランタイムエラーの Slack 通知（notifySlackError_、be_slack.js）を
 * 試みる。Slack 通知側の失敗（未実装漏れ・Webhook未設定・通信エラー等）が
 * ログ出力自体に影響しないよう、try/catch で二重に防御する
 * （notifySlackError_ 自身の内部にも同様の防御がある）。
 *
 * @param {string} tag - ログのカテゴリタグ
 * @param {string} message - ログメッセージ
 * @param {*} [error] - エラーオブジェクトまたは任意の値（文字列・オブジェクト等も可）
 * @param {Object} [context] - Slack通知用の追加コンテキスト（省略可。例: { wholesalerId, wholesalerName, invoiceUuid, actionLabel }）
 */
function logError_(tag, message, error, context) {
  let errorDetail;
  if (error == null) {
    errorDetail = message;
  } else if (error instanceof Error) {
    errorDetail = message + ': ' + error.message + '\\n' + (error.stack || '');
  } else if (typeof error === 'string') {
    errorDetail = message + ': ' + error;
  } else {
    try {
      errorDetail = message + ': ' + JSON.stringify(error);
    } catch (_) {
      errorDetail = message + ': ' + String(error);
    }
  }
  Logger.log('[ERROR][' + tag + '] ' + sanitizeLogMessage_(errorDetail));

  try {
    notifySlackError_(tag, message, error, context);
  } catch (_) {
    // notifySlackError_（be_slack.js）内部の想定漏れによる例外も、
    // ここで確実に握りつぶす（二重防御）。ログ出力自体は上記で完了済みのため、
    // Slack通知の失敗がアプリの動作に一切影響しない。
  }
}

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
