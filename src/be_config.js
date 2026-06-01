// =============================================================================
// Config: Script Properties から環境設定を取得する
//
// GAS エディタ or clasp で以下のプロパティを設定してください:
//   DRIVE_ROOT_FOLDER_ID   … 監査証跡 CSV の保存先 Drive フォルダ ID
//   GCP_PROJECT_ID         … BigQuery の GCP プロジェクト ID
//   BQ_DATASET_ID          … BigQuery のデータセット ID（例: connect_db）
//   BQ_LOCATION            … BigQuery のリージョン（例: asia-northeast1。未設定時は US フォールバック）
//   GOOGLE_CLIENT_ID      … Google OAuth 2.0 クライアント ID（ログイン認証用）
//
// 設定方法（GASエディタ）:
//   プロジェクトの設定 → スクリプト プロパティ → プロパティを追加
// =============================================================================

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const driveFolderId = props.getProperty('DRIVE_ROOT_FOLDER_ID');
  const gcpProjectId  = props.getProperty('GCP_PROJECT_ID');
  const bqDatasetId   = props.getProperty('BQ_DATASET_ID');
  const bqLocation    = props.getProperty('BQ_LOCATION') || 'US';

  if (!driveFolderId) throw new Error('Script Property "DRIVE_ROOT_FOLDER_ID" が未設定です');
  if (!gcpProjectId)  throw new Error('Script Property "GCP_PROJECT_ID" が未設定です');
  if (!bqDatasetId)   throw new Error('Script Property "BQ_DATASET_ID" が未設定です');

  return { driveFolderId, gcpProjectId, bqDatasetId, bqLocation };
}

// =============================================================================
// Script Properties セットアップヘルパー
//
// 初回デプロイ時に GAS エディタからこの関数を1度だけ実行してください。
// 本番環境では値を書き換えてから実行するか、GAS UI から直接プロパティを設定してください。
//
// ガード仕様:
//   1. ENV プロパティが 'production' の場合は実行を拒否する
//   2. すでに BACKOFFICE_API_POST_URL が設定済みの場合は上書きしない
//      （再セットアップが必要な場合は forceOverwrite 引数に true を渡す）
// =============================================================================

function setupScriptProperties(forceOverwrite) {
  const props = PropertiesService.getScriptProperties();

  // ── ガード1: 本番環境では実行不可 ─────────────────────────────────────────
  const env = props.getProperty('ENV');
  if (env === 'production') {
    throw new Error(
      '[setupScriptProperties] ENV=production の環境では実行できません。' +
      '本番の設定変更は GAS UI（プロジェクトの設定 → スクリプトプロパティ）から直接行ってください。'
    );
  }

  // ── ガード2: 既存値がある場合は上書きしない（forceOverwrite=true で回避可） ──
  const existingFolderId = props.getProperty('DRIVE_ROOT_FOLDER_ID');
  if (existingFolderId && !forceOverwrite) {
    throw new Error(
      '[setupScriptProperties] Script Properties はすでに設定済みです（上書きをスキップしました）。\n' +
      '再セットアップする場合は setupScriptProperties(true) を実行してください。'
    );
  }

  // ── 設定値の書き込み ────────────────────────────────────────────────────────
  props.setProperties({
    'DRIVE_ROOT_FOLDER_ID': '1rGvUwmPpkxTsYN2tRIo-UM4PnKAnx5Ro',  // 本番フォルダ ID に変更してください
    'GCP_PROJECT_ID':       'usenpay-connect-dev',
    'BQ_DATASET_ID':        'connect_db',
    'GOOGLE_CLIENT_ID':     '922908723040-iiolmgkq3g812at66h44fjb1u1h8hgns.apps.googleusercontent.com',
    'ENV':                  'development',
  });
  console.log('[setupScriptProperties] Script Properties を設定しました（ENV=development）。');
}

// =============================================================================
// 個別プロパティ上書き用ヘルパー
// GAS エディタから直接実行して特定のプロパティだけ更新する場合に使う。
// 例: BQ_DATASET_ID だけ変えたい、API_KEY だけ差し替えたい、など。
//
// 使い方:
//   1. GAS エディタ上部のドロップダウンで実行したい関数を選択して実行。
//   2. または overwriteScriptProperty_('BQ_DATASET_ID', 'connect_db') のように
//      任意のキーと値を渡して Script Editor の実行ボタンで呼ぶ。
// =============================================================================

/** BQ_DATASET_ID を connect_db に更新する */
function overwriteBqDatasetId() {
  overwriteScriptProperty_('BQ_DATASET_ID', 'connect_db');
}

/** BQ_LOCATION を asia-northeast1 に更新する */
function overwriteBqLocation() {
  overwriteScriptProperty_('BQ_LOCATION', 'asia-northeast1');
}

/** GCP_PROJECT_ID を更新する（値は関数内を直接編集してから実行） */
function overwriteGcpProjectId() {
  overwriteScriptProperty_('GCP_PROJECT_ID', 'usenpay-connect-dev');
}

/** GOOGLE_CLIENT_ID を更新する（値は関数内を直接編集してから実行） */
function overwriteGoogleClientId() {
  overwriteScriptProperty_('GOOGLE_CLIENT_ID', '922908723040-iiolmgkq3g812at66h44fjb1u1h8hgns.apps.googleusercontent.com');
}

/**
 * Script Property を1件だけ上書きする内部ヘルパー。
 * ENV=production の環境では実行を拒否する。
 *
 * @param {string} key   - プロパティキー
 * @param {string} value - 設定する値
 */
function overwriteScriptProperty_(key, value) {
  const props = PropertiesService.getScriptProperties();
  const env   = props.getProperty('ENV');
  if (env === 'production') {
    throw new Error(
      '[overwriteScriptProperty_] ENV=production の環境では実行できません。' +
      '本番の設定変更は GAS UI（プロジェクトの設定 → スクリプトプロパティ）から直接行ってください。'
    );
  }
  props.setProperty(key, value);
  console.log('[overwriteScriptProperty_] ' + key + ' = ' + value + ' に更新しました。');
}
