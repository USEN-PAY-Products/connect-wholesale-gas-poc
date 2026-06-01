// =============================================================================
// auth.js （認証 API 専用 GAS プロジェクト）
//
// 外部フロント（AWS ログインページ等）からの認証リクエストを処理する。
// Google ID トークンの検証と BQ アカウント照合を行い、JSON レスポンスを返す。
//
// ── 設計メモ ──
// メインの GAS Webアプリ（卸システム）とは別プロジェクトとしてデプロイする。
//   - メインアプリ: access=DOMAIN  → Session.getActiveUser() でユーザー特定
//   - 本プロジェクト: access=ANYONE_ANONYMOUS → 外部オリジンからの fetch() に対応
//
// 依存: BigQuery Advanced Service（appsscript.json で有効化）
//       スクリプトプロパティ: GCP_PROJECT_ID, BQ_DATASET_ID, GOOGLE_CLIENT_ID
//
// 公開関数:
//   doPost(e)  ← GAS ウェブアプリの POST エントリーポイント
// =============================================================================

/**
 * 外部フロント（AWS ログインページ等）からの POST リクエストを処理する。
 * Google ID トークンを受け取り、サーバー側で検証後、BQ でアカウント照合を行う。
 *
 * リクエスト:  { "token": "<Google ID トークン>" }
 * レスポンス:
 *   成功時: { status: "success", userData: {...} }
 *   未登録: { status: "fail",    message: "..." }
 *   エラー: { status: "error",   message: "..." }
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ status: 'error', message: 'リクエストボディが空です。' });
    }

    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse_({ status: 'error', message: 'リクエストの形式が不正です。JSON 形式で送信してください。' });
    }

    const idToken = body.token;
    if (!idToken) {
      return jsonResponse_({ status: 'error', message: 'トークンが送信されていません。' });
    }

    // ── Google tokeninfo API でトークンを検証 ──
    const verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
    const verifyRes = UrlFetchApp.fetch(verifyUrl, { muteHttpExceptions: true });
    const verifyCode = verifyRes.getResponseCode();
    if (verifyCode !== 200) {
      const verifyBody = verifyRes.getContentText();
      Logger.log('[doPost] tokeninfo API エラー: status=' + verifyCode + ', body=' + verifyBody);
      if (verifyCode === 429 || verifyCode >= 500) {
        return jsonResponse_({ status: 'error', message: 'Google認証サーバーが一時的に利用できません。しばらく待ってから再度お試しください。' });
      }
      return jsonResponse_({ status: 'error', message: '無効なトークンです。再度ログインしてください。' });
    }

    const tokenInfo = JSON.parse(verifyRes.getContentText());

    // ── aud（クライアントID）の一致を検証 ──
    const googleClientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
    if (!googleClientId) {
      Logger.log('[doPost] GOOGLE_CLIENT_ID がスクリプトプロパティに未設定です。');
      return jsonResponse_({ status: 'error', message: 'サーバー設定エラーです。管理者に連絡してください。' });
    }
    if (tokenInfo.aud !== googleClientId) {
      Logger.log('[doPost] aud 不一致: expected=' + googleClientId + ', got=' + tokenInfo.aud);
      return jsonResponse_({ status: 'error', message: '無効なトークンです。再度ログインしてください。' });
    }

    // ── iss（発行者）の検証 ──
    if (tokenInfo.iss !== 'accounts.google.com' && tokenInfo.iss !== 'https://accounts.google.com') {
      Logger.log('[doPost] iss 不正: ' + tokenInfo.iss);
      return jsonResponse_({ status: 'error', message: '無効なトークンです。再度ログインしてください。' });
    }

    // ── メールアドレスの検証済みチェック ──
    if (String(tokenInfo.email_verified) !== 'true') {
      return jsonResponse_({ status: 'error', message: 'メールアドレスが未確認のアカウントではログインできません。' });
    }

    const email = tokenInfo.email;
    if (!email) {
      return jsonResponse_({ status: 'error', message: 'トークンからメールアドレスを取得できませんでした。' });
    }

    // ── BQ でアカウント照合 ──
    const accountInfo = fetchAccountForAuth_(email);
    if (!accountInfo) {
      return jsonResponse_({
        status: 'fail',
        message: 'このアカウントは登録されていません。\n登録済みのGoogleアカウントで再度ログインしてください。',
      });
    }

    return jsonResponse_({ status: 'success', userData: accountInfo });

  } catch (err) {
    Logger.log('[doPost] エラー: ' + err.message);
    return jsonResponse_({ status: 'error', message: '認証処理中にエラーが発生しました。' });
  }
}

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * JSON レスポンスを生成するヘルパー。
 * GAS の doPost は自動リダイレクト経由で応答するため、
 * カスタム CORS ヘッダは不要（フロント側は Content-Type: text/plain で送信）。
 * @param {Object} obj - レスポンスオブジェクト
 * @returns {TextOutput}
 */
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =============================================================================
// BQ アカウント照合（認証 API 用・最小限フィールドのみ）
// =============================================================================

/**
 * メールアドレスからアカウントの存在確認と最小限の情報を取得する。
 * メインアプリの fetchAccountInfoByEmail_ とは異なり、ログイン画面で必要な
 * wholesaler_id / wholesaler_name のみ返す（加盟店マッピング等は含まない）。
 *
 * @param {string} email - Google ID トークンから取得したメールアドレス
 * @returns {{ wholesaler_id: number, wholesaler_name: string }|null}
 */
function fetchAccountForAuth_(email) {
  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty('GCP_PROJECT_ID');
  const datasetId = props.getProperty('BQ_DATASET_ID');

  if (!projectId || !datasetId) {
    throw new Error('GCP_PROJECT_ID または BQ_DATASET_ID が未設定です。');
  }

  const sql =
    'SELECT wu.wholesaler_id, w.wholesaler_name ' +
    'FROM `' + projectId + '.' + datasetId + '.wholesaler_user` AS wu ' +
    'JOIN `' + projectId + '.' + datasetId + '.wholesalers` AS w ' +
    '  ON w.id = wu.wholesaler_id AND w.wholesaler_status = \'active\' ' +
    'WHERE wu.wholesaler_email = @email ' +
    '  AND wu.deleted_at IS NULL ' +
    'LIMIT 1';

  const request = {
    query:           sql,
    useLegacySql:    false,
    timeoutMs:       10000,
    queryParameters: [
      { name: 'email', parameterType: { type: 'STRING' }, parameterValue: { value: email } },
    ],
  };

  const response = BigQuery.Jobs.query(request, projectId);

  if (response.errors && response.errors.length > 0) {
    throw new Error('[BQ] クエリエラー: ' + JSON.stringify(response.errors));
  }

  // jobComplete=false の場合はポーリングで完了を待つ（最大5回 = 最大10秒）
  let result = response;
  if (!result.jobComplete) {
    const jobId = result.jobReference && result.jobReference.jobId;
    if (!jobId) {
      throw new Error('[BQ] jobId が取得できませんでした。');
    }
    const MAX_POLL = 5;
    for (let i = 0; i < MAX_POLL && !result.jobComplete; i++) {
      Logger.log('[BQ] クエリ実行中... ポーリング ' + (i + 1) + '/' + MAX_POLL);
      Utilities.sleep(2000);
      result = BigQuery.Jobs.getQueryResults(projectId, jobId, { timeoutMs: 10000 });
      if (result.errors && result.errors.length > 0) {
        throw new Error('[BQ] クエリエラー（ポーリング中）: ' + JSON.stringify(result.errors));
      }
    }
    if (!result.jobComplete) {
      throw new Error('[BQ] クエリがタイムアウトしました。');
    }
  }

  const rows = result.rows;
  if (!rows || rows.length === 0) return null;

  const fields = result.schema.fields;
  const row = rows[0];
  const obj = {};
  (row.f || []).forEach(function(cell, idx) {
    obj[fields[idx].name] = cell.v;
  });

  return {
    wholesaler_id:   Number(obj.wholesaler_id),
    wholesaler_name: obj.wholesaler_name || '',
  };
}

// =============================================================================
// スクリプトプロパティ セットアップ
//
// 初回デプロイ時に GAS エディタから実行してください。
// =============================================================================

/**
 * 認証 API 用のスクリプトプロパティを設定する。
 * メインアプリと同じ GCP プロジェクト・データセット・クライアント ID を使用する。
 */
function setupAuthScriptProperties() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    GCP_PROJECT_ID:   'your-gcp-project-id',
    BQ_DATASET_ID:    'connect_db',
    GOOGLE_CLIENT_ID: '922908723040-iiolmgkq3g812at66h44fjb1u1h8hgns.apps.googleusercontent.com',
  });
  Logger.log('[setup] 認証 API のスクリプトプロパティを設定しました。');
}
