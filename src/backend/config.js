// =============================================================================
// Config: Script Properties から環境設定を取得する
//
// GAS エディタ or clasp で以下のプロパティを設定してください:
//   BACKOFFICE_API_POST_URL  … 請求データ送信先エンドポイント
//   BACKOFFICE_API_GET_URL   … 請求一覧・詳細取得エンドポイント
//   DRIVE_ROOT_FOLDER_ID     … 監査証跡 CSV の保存先 Drive フォルダ ID
//
// 設定方法（GASエディタ）:
//   プロジェクトの設定 → スクリプト プロパティ → プロパティを追加
// =============================================================================

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const postUrl       = props.getProperty('BACKOFFICE_API_POST_URL');
  const getUrl        = props.getProperty('BACKOFFICE_API_GET_URL');
  const driveFolderId = props.getProperty('DRIVE_ROOT_FOLDER_ID');

  if (!postUrl)       throw new Error('Script Property "BACKOFFICE_API_POST_URL" が未設定です');
  if (!getUrl)        throw new Error('Script Property "BACKOFFICE_API_GET_URL" が未設定です');
  if (!driveFolderId) throw new Error('Script Property "DRIVE_ROOT_FOLDER_ID" が未設定です');

  return {
    postUrl:       postUrl,
    getUrl:        getUrl,
    driveFolderId: driveFolderId
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
  const existingPostUrl = props.getProperty('BACKOFFICE_API_POST_URL');
  if (existingPostUrl && !forceOverwrite) {
    throw new Error(
      '[setupScriptProperties] Script Properties はすでに設定済みです（上書きをスキップしました）。\n' +
      '再セットアップする場合は setupScriptProperties(true) を実行してください。'
    );
  }

  // ── 設定値の書き込み ────────────────────────────────────────────────────────
  props.setProperties({
    'BACKOFFICE_API_POST_URL': 'https://httpbin.org/post',            // 本番 URL に変更してください
    'BACKOFFICE_API_GET_URL':  'https://httpbin.org/get',             // 本番 URL に変更してください
    'DRIVE_ROOT_FOLDER_ID':    '1rGvUwmPpkxTsYN2tRIo-UM4PnKAnx5Ro', // 本番フォルダ ID に変更してください
    'ENV':                     'development'                          // 本番では 'production' に変更してください
  });
  console.log('[setupScriptProperties] Script Properties を設定しました（ENV=development）。');
}
