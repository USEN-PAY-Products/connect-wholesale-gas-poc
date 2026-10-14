// =============================================================================
// Config: Script Properties から環境設定を取得する
//
// GAS エディタ or clasp で以下のプロパティを設定してください:
//   DRIVE_ROOT_FOLDER_ID … 監査証跡 CSV の保存先 Drive フォルダ ID
//   GCP_PROJECT_ID       … BigQuery の GCP プロジェクト ID
//   BQ_DATASET_ID        … BigQuery のデータセット ID（例: connect_db）
//   BQ_LOCATION          … BigQuery のリージョン（例: asia-northeast1。未設定時は US フォールバック）
//   ENV                  … 実行環境（development / production）。development のときヘッダー等に "(Dev)" を表示
//   ALLOWED_DOMAINS      … 許可するドメイン（カンマ区切り。未設定＝制限なし）
//   ALLOWED_EMAILS       … 許可するメールアドレス（カンマ区切り。未設定＝制限なし）
//   BACKOFFICE_URL       … BackOffice へ戻るリンクの遷移先（script.google.com の exec URL のみ）
//   WEB_APP_URL          … 卸切替後に開く Web アプリ URL（exec / dev。未設定時は ScriptApp の URL）
//   FAVICON_URL          … ファビコン画像の公開URL（https のみ。未設定＝ファビコンなし）
//
// 設定方法（GASエディタ）:
//   プロジェクトの設定 → スクリプト プロパティ → プロパティを追加
//
// 【重要】Script Property を書き換えるトップレベル関数は追加しない。
//   executeAs: USER_DEPLOYING では操作者権限でプロパティを書き換えられてしまうため。
//   設定変更は GAS の UI（プロジェクトの設定 → スクリプト プロパティ）から行う。
// =============================================================================

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const driveFolderId = props.getProperty('DRIVE_ROOT_FOLDER_ID');
  const gcpProjectId  = props.getProperty('GCP_PROJECT_ID');
  const bqDatasetId   = props.getProperty('BQ_DATASET_ID');
  const bqLocation    = props.getProperty('BQ_LOCATION') || 'US';
  const env           = props.getProperty('ENV') || '';

  if (!driveFolderId) throw new Error('Script Property "DRIVE_ROOT_FOLDER_ID" が未設定です');
  if (!gcpProjectId)  throw new Error('Script Property "GCP_PROJECT_ID" が未設定です');
  if (!bqDatasetId)   throw new Error('Script Property "BQ_DATASET_ID" が未設定です');

  const splitCsv = function (v) {
    return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  };

  // script.google.com の exec URL 形式のみ許可（誤設定時の任意サイトへの誘導防止）
  const webAppUrlPattern = /^https:\/\/script\.google\.com\/(a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]+\/(exec|dev)$/;
  const rawWebAppUrl = (props.getProperty('WEB_APP_URL') || '').trim();
  // 未設定・不正値は空にし、doGet 側で現在のサービスURL（ScriptApp.getService().getUrl()）にフォールバックする
  const webAppUrl = webAppUrlPattern.test(rawWebAppUrl)
    ? rawWebAppUrl
    : '';
  const rawBackOfficeUrl = (props.getProperty('BACKOFFICE_URL') || '').trim();
  const backOfficeUrl = /^https:\/\/script\.google\.com\/(a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/.test(rawBackOfficeUrl)
    ? rawBackOfficeUrl
    : '';

  return {
    driveFolderId,
    gcpProjectId,
    bqDatasetId,
    bqLocation,
    env,
    allowedDomains: splitCsv(props.getProperty('ALLOWED_DOMAINS')),
    allowedEmails:  splitCsv(props.getProperty('ALLOWED_EMAILS')),
    webAppUrl,
    backOfficeUrl,
  };
}
