// =============================================================================
// ★ STUB MODE ★
// BQテーブルおよびバックオフィスAPIの準備が完了するまで true にしておく。
// 準備が完了したら false に変更して clasp push する。
// =============================================================================
/** Drive保存・BQ書き込みのスタブ。false = 本番動作。 */
const STUB_MODE = false;
// ★ getAccountInfo のスタブ切り替えは Script Properties "STUB_ACCOUNT_INFO_MODE" で行う。
// GAS エディタ → プロジェクトの設定 → スクリプトプロパティ で 'true' / 'false' を設定。
// be_config.js の getConfig_().stubAccountInfoMode がその値を読み込む。

/** getAccountInfo のスタブ返却値。実際のAPIレスポンス構造に合わせる。 */
const STUB_ACCOUNT_INFO = {
  wholesaler_id:      1,
  wholesaler_user_id: '00000000-0000-0000-0000-000000000001',
  wholesaler_name:    '（スタブ）卸業者サンプル',
  user_name:          'スタブ 太郎',
  fee_rate:           5,
  merchant_mappings: [
    { customer_code: 'C001', mall_code: 'MALL-001', merchant_name: 'サンプル加盟店A', is_active: true },
    { customer_code: 'C002', mall_code: 'MALL-002', merchant_name: 'サンプル加盟店B', is_active: true },
  ],
  csv_format_rules: null,   // null = デフォルトフォーマットを使用
};

// =============================================================================
// Private utility helpers は be_utils.js / be_main.js に集約済み。
// このファイルでは doGet / success_ / error_ / getWholesalerId_ /
// getOrCreateSubFolder_ / formatTimestamp_ / formatYearMonth_ を定義しない。
// =============================================================================

// =============================================================================
// 1. doGet は be_main.js で定義済み
// =============================================================================

// =============================================================================
// 2. getAccountInfo
// =============================================================================

/**
 * バックオフィスAPIまたはスタブからアカウント情報オブジェクトを返す内部ヘルパー。
 * sendInvoiceData など複数箇所から呼ばれる。
 *
 * @returns {Object} STUB_ACCOUNT_INFO またはAPIレスポンスの data 相当オブジェクト
 * @throws {Error} API エラー時
 */
function getServerAccountInfo_() {
  const config = getConfig_();

  if (config.stubAccountInfoMode) {
    Logger.log('[STUB] getServerAccountInfo_: スタブデータを返します');
    return STUB_ACCOUNT_INFO;
  }

  // TODO: アカウント情報取得API本格実装時に認証フィールド（email等）を追加する
  const payload = {
    api_key: config.apiKey,
  };

  const options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response     = UrlFetchApp.fetch(config.accountApiUrl, options);
  const responseCode = response.getResponseCode();
  const rawText      = response.getContentText();
  let responseBody;
  try {
    responseBody = JSON.parse(rawText);
  } catch (_) {
    responseBody = rawText;
  }

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error('AccountInfo API error (HTTP ' + responseCode + '): ' + JSON.stringify(responseBody));
  }
  if (responseBody && responseBody.status === 'error') {
    throw new Error('AccountInfo API error (' + responseBody.error_type + '): ' + JSON.stringify(responseBody));
  }

  // API が { status: 'success', data: {...} } 形式の場合は data 部分のみ返す。
  // data プロパティがない場合はレスポンス全体をそのまま返す（後方互換）。
  return (responseBody && responseBody.data !== undefined) ? responseBody.data : responseBody;
}

/**
 * バックオフィスGASのアカウント情報取得APIを呼び出し、卸情報を返す。
 * フロントエンドの DOMContentLoaded 時に google.script.run 経由で呼ばれる。
 *
 * @returns {{ status: 'success', data: Object }}
 * @throws {Error} API エラー時
 */
function getAccountInfo() {
  try {
    return success_(getServerAccountInfo_());
  } catch (err) {
    throw new Error('getAccountInfo failed: ' + err.message);
  }
}


// --- 請求登録・取得系の公開関数は be_invoice.js で定義 ---

