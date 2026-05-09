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

function _getConfig() {
  var props = PropertiesService.getScriptProperties();
  var postUrl       = props.getProperty('BACKOFFICE_API_POST_URL');
  var getUrl        = props.getProperty('BACKOFFICE_API_GET_URL');
  var driveFolderId = props.getProperty('DRIVE_ROOT_FOLDER_ID');

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
// =============================================================================

function setupScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    'BACKOFFICE_API_POST_URL': 'https://httpbin.org/post',            // 本番 URL に変更してください
    'BACKOFFICE_API_GET_URL':  'https://httpbin.org/get',             // 本番 URL に変更してください
    'DRIVE_ROOT_FOLDER_ID':    '1rGvUwmPpkxTsYN2tRIo-UM4PnKAnx5Ro', // 本番フォルダ ID に変更してください
    'ENV':                     'development'                          // 本番では 'production' に変更してください
  });
  console.log('Script Properties を設定しました。');
}
