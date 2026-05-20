// =============================================================================
// Config: Script Properties から環境設定を取得する
//
// GAS エディタ or clasp で以下のプロパティを設定してください:
//   ACCOUNT_API_URL        … バックオフィスGASのアカウント情報取得APIエンドポイント
//   API_KEY                … バックオフィスAPIの認証キー
//   DRIVE_ROOT_FOLDER_ID   … 監査証跡 CSV の保存先 Drive フォルダ ID
//   GCP_PROJECT_ID         … BigQuery の GCP プロジェクト ID
//   BQ_DATASET_ID          … BigQuery のデータセット ID（例: invoice_db）
//   STUB_ACCOUNT_INFO_MODE … 'true' = getAccountInfo をスタブ返却（API未整備時）
//                            'false' = バックオフィスAPIを実際に呼び出す
//
// 設定方法（GASエディタ）:
//   プロジェクトの設定 → スクリプト プロパティ → プロパティを追加
// =============================================================================

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const accountApiUrl  = props.getProperty('ACCOUNT_API_URL');
  const apiKey         = props.getProperty('API_KEY');
  const driveFolderId  = props.getProperty('DRIVE_ROOT_FOLDER_ID');
  const gcpProjectId   = props.getProperty('GCP_PROJECT_ID');
  const bqDatasetId    = props.getProperty('BQ_DATASET_ID');

  // DRIVE_ROOT_FOLDER_ID / GCP_PROJECT_ID / BQ_DATASET_ID は常に必須。
  // ACCOUNT_API_URL / API_KEY は STUB_ACCOUNT_INFO_MODE=false のときのみ必要。
  // STUB_ACCOUNT_INFO_MODE は Script Properties から読み込み、be_server.js の定数に依存しない。
  // 値が 'false'（文字列）のときだけ false と見なし、未設定・'true' はすべて true 扱い。
  const stubAccountInfoMode = props.getProperty('STUB_ACCOUNT_INFO_MODE') !== 'false';

  if (!driveFolderId) throw new Error('Script Property "DRIVE_ROOT_FOLDER_ID" が未設定です');
  if (!gcpProjectId)  throw new Error('Script Property "GCP_PROJECT_ID" が未設定です');
  if (!bqDatasetId)   throw new Error('Script Property "BQ_DATASET_ID" が未設定です');

  if (!stubAccountInfoMode) {
    if (!accountApiUrl) throw new Error('Script Property "ACCOUNT_API_URL" が未設定です');
    if (!apiKey)        throw new Error('Script Property "API_KEY" が未設定です');
  }

  return {
    accountApiUrl: accountApiUrl,
    apiKey:        apiKey,
    driveFolderId: driveFolderId,
    gcpProjectId:  gcpProjectId,
    bqDatasetId:   bqDatasetId,
  };
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
    'ACCOUNT_API_URL':      'https://script.google.com/macros/s/XXXXX/exec', // バックオフィスGAS URL に変更してください
    'API_KEY':              'YOUR_SECRET_API_KEY',                            // APIキーに変更してください
    'DRIVE_ROOT_FOLDER_ID': '1rGvUwmPpkxTsYN2tRIo-UM4PnKAnx5Ro',            // 本番フォルダ ID に変更してください
    'GCP_PROJECT_ID':       'usenpay-connect-dev',                            // GCP プロジェクト ID
    'BQ_DATASET_ID':        'invoice_db',                                     // BigQuery データセット ID
    'ENV':                  'development',                                    // 本番では 'production' に変更してください
    'STUB_ACCOUNT_INFO_MODE': 'true',                                         // バックオフィスAPI整備後に 'false' に変更してください
  });
  console.log('[setupScriptProperties] Script Properties を設定しました（ENV=development）。');
}

// ★ 一時関数 ★ Script Properties を強制上書きする。
// development 環境でのみ実行可。バックオフィスAPI整備後は削除すること。
function setupForce() {
  const env = PropertiesService.getScriptProperties().getProperty('ENV');
  if (env === 'production') {
    throw new Error('[setupForce] production 環境では実行できません。');
  }
  setupScriptProperties(true);
}
