// =============================================================================
// db_bq_connection.js
//
// BigQuery への書き込み接続ロジックを管理するファイル。
// Load Job（大量明細）+ マルチステートメント・トランザクション方式。
//
// 登録フロー:
//   ③ loadCsvToBq_()       … 生CSV を BQ Load Job で staging テーブルへ投入
//   ④ waitForLoadJob_()    … Load Job の完了をポーリング待機
//   ⑤ runTransactionSql_() … BEGIN TRANSACTION 〜 COMMIT を1発実行
//   ⑥ dropStagingTable_()  … 使い捨て staging テーブルを DROP（TRANSACTION 外）
//
// 依存: be_config.js（getConfig_）
// =============================================================================

/**
 * staging テーブルのスキーマ定義。
 * CSV の各列をそのまま格納する（GAS 側での変換なし）。
 * Load Job 投入時に schema フィールドとして渡す。
 */
const STAGING_SCHEMA_ = {
  fields: [
    { name: 'customer_code',         type: 'STRING'  },
    { name: 'transaction_date',      type: 'DATE'    },
    { name: 'item_name',             type: 'STRING'  },
    { name: 'quantity',              type: 'NUMERIC' },
    { name: 'unit_price',            type: 'NUMERIC' },
    { name: 'tax_rate',              type: 'INTEGER' },
    { name: 'amount_ex_tax',         type: 'NUMERIC' },
    { name: 'tax_amount',            type: 'NUMERIC' },
    { name: 'invoice_detail_remark', type: 'STRING'  },
  ],
};

/**
 * CSV バイト列を BQ Load Job で指定の staging テーブルへ投入する。
 * GAS は CSV を一切パースしない。バイト列をそのまま BQ へ横流しするだけ。
 *
 * ⚠️ 元 CSV が Shift-JIS の場合、フロント側で UTF-8 に変換してから base64 エンコードすること。
 *    BQ Load Job は UTF-8 / ISO-8859-1 のみサポートしており、Shift-JIS は非サポート。
 *
 * @param {string}   projectId      - GCP プロジェクトID
 * @param {string}   datasetId      - BQ データセットID
 * @param {string}   stagingTableId - 宛先テーブルID（UUID付き、ハイフン→アンダースコア済み）
 * @param {number[]} csvBytes       - Utilities.base64Decode() で得た生バイト配列
 * @param {Object}   [schema]       - BQ スキーマ定義（省略時は STAGING_SCHEMA_ を使用）
 *                                    csv_format_rules がある場合は buildStagingSchema_() の結果を渡す。
 * @param {string}   [location]     - BQ リージョン（例: 'asia-northeast1'。未指定時は 'US'）
 * @returns {string} 投入した Load Job の jobId
 * @throws {Error} Load Job 投入失敗時
 */
function loadCsvToBq_(projectId, datasetId, stagingTableId, csvBytes, schema, location) {
  const blob = Utilities.newBlob(csvBytes, 'application/octet-stream');
  const jobResource = {
    configuration: {
      load: {
        destinationTable: {
          projectId: projectId,
          datasetId: datasetId,
          tableId:   stagingTableId,
        },
        sourceFormat:     'CSV',
        skipLeadingRows:  1,
        writeDisposition: 'WRITE_TRUNCATE',
        encoding:         'UTF-8',
        // クォート内の改行を許容する（フロントのパーサ取りこぼし・直接呼び出し時の最終防衛）。
        // これがないとクォート内改行を含む 1 行で Load Job 全体が失敗する。
        allowQuotedNewlines: true,
        schema:           schema || STAGING_SCHEMA_,
      },
    },
    jobReference: {
      projectId: projectId,
      location:  location || 'US',
    },
  };

  Logger.log('[BQ] Load Job 投入: stagingTable=' + stagingTableId);
  const response = BigQuery.Jobs.insert(jobResource, projectId, blob);
  if (!response || !response.jobReference || !response.jobReference.jobId) {
    throw new Error('[BQ] Load Job 投入失敗: jobReference が取得できませんでした');
  }
  const jobId = response.jobReference.jobId;
  Logger.log('[BQ] Load Job 投入完了: jobId=' + jobId);
  return jobId;
}

/**
 * BQ Load Job の完了をポーリングで待機する。
 * 最大 60 回（= 約 2 分）ポーリングし、タイムアウトまたはエラーで例外をスローする。
 *
 * @param {string} projectId - GCP プロジェクトID
 * @param {string} jobId     - 待機対象の Load Job ID
 * @param {string} [location] - BQ リージョン
 * @throws {Error} Load Job 失敗またはタイムアウト時
 */
function waitForLoadJob_(projectId, jobId, location) {
  const MAX_POLL      = 60;
  const POLL_INTERVAL = 2000; // ms
  for (let i = 0; i < MAX_POLL; i++) {
    const job       = BigQuery.Jobs.get(projectId, jobId, location ? { location: location } : {});
    const state     = job.status && job.status.state;
    const errResult = job.status && job.status.errorResult;

    if (errResult) {
      throw new Error('[BQ] Load Job 失敗 (jobId: ' + jobId + '): ' + JSON.stringify(errResult));
    }
    if (state === 'DONE') {
      Logger.log('[BQ] Load Job 完了: jobId=' + jobId);
      return;
    }
    Logger.log('[BQ] Load Job 実行中... ポーリング ' + (i + 1) + '/' + MAX_POLL + ' (state=' + state + ')');
    Utilities.sleep(POLL_INTERVAL);
  }
  throw new Error('[BQ] Load Job タイムアウト（jobId: ' + jobId + '）');
}

/**
 * BQ マルチステートメント・トランザクション SQL を実行する。
 * BEGIN TRANSACTION 〜 COMMIT を含む SQL 文字列を1発で実行し、
 * 完了するまでポーリングで待機する。
 *
 * エラー発生時は BQ が自動ロールバックするため、補償削除コードは不要。
 * GAS 自体がタイムアウトした場合も BQ 側でロールバックがかかる。
 *
 * @param {string} projectId - GCP プロジェクトID
 * @param {string} sql       - BEGIN TRANSACTION 〜 COMMIT を含む SQL 全文
 * @throws {Error} トランザクション失敗時
 */
function runTransactionSql_(projectId, sql) {
  Logger.log('[BQ] トランザクション SQL 実行開始');
  // location はデータセットのリージョンと一致させる必要がある（BQ_LOCATION スクリプトプロパティで設定）。
  // 未指定だと getQueryResults がデフォルト US でジョブを探し「Not found: Job」になる。
  const location = getConfig_().bqLocation;
  const request = {
    query:        sql,
    useLegacySql: false,
    timeoutMs:    10000,
    location:     location,
  };

  let response = BigQuery.Jobs.query(request, projectId);
  if (response.errors && response.errors.length > 0) {
    throw new Error('[BQ] トランザクションエラー: ' + JSON.stringify(response.errors));
  }

  const jobId = response.jobReference && response.jobReference.jobId;
  if (!jobId) throw new Error('[BQ] jobId が取得できませんでした（トランザクション）');

  const MAX_POLL = 30;
  for (let poll = 0; !response.jobComplete && poll < MAX_POLL; poll++) {
    Logger.log('[BQ] トランザクション実行中... ポーリング ' + (poll + 1) + '/' + MAX_POLL);
    Utilities.sleep(2000);
    response = BigQuery.Jobs.getQueryResults(projectId, jobId, { timeoutMs: 10000, location: location });
    if (response.errors && response.errors.length > 0) {
      throw new Error('[BQ] トランザクションエラー（ポーリング中）: ' + JSON.stringify(response.errors));
    }
  }

  if (!response.jobComplete) {
    throw new Error('[BQ] トランザクションがタイムアウトしました（jobId: ' + jobId + '）');
  }
  Logger.log('[BQ] トランザクション完了: jobId=' + jobId);
}

/**
 * 使い捨て staging テーブルを DROP する。
 * トランザクション外で実行すること（BQ の DDL は TRANSACTION 内に含められない）。
 * DROP 失敗は致命的ではない（DB への全登録は成功済み）。
 *
 * @param {string} projectId      - GCP プロジェクトID
 * @param {string} datasetId      - BQ データセットID
 * @param {string} stagingTableId - 削除するテーブルID
 * @throws {Error} DROP 失敗時
 */
function dropStagingTable_(projectId, datasetId, stagingTableId) {
  const fullRef = '`' + projectId + '.' + datasetId + '.' + stagingTableId + '`';
  const sql     = 'DROP TABLE IF EXISTS ' + fullRef;

  Logger.log('[BQ] staging テーブルを DROP: ' + stagingTableId);
  // location はデータセットのリージョンと一致させる必要がある（BQ_LOCATION スクリプトプロパティで設定）。
  // 未指定だと getQueryResults がデフォルト US でジョブを探し「Not found: Job」になる。
  const location = getConfig_().bqLocation;
  const request = {
    query:        sql,
    useLegacySql: false,
    timeoutMs:    10000,
    location:     location,
  };

  let response = BigQuery.Jobs.query(request, projectId);
  if (response.errors && response.errors.length > 0) {
    throw new Error(
      '[BQ] staging テーブルの DROP に失敗しました（テーブル名: ' + stagingTableId +
      '）。手動で DROP してください。詳細: ' + JSON.stringify(response.errors)
    );
  }

  const jobId = response.jobReference && response.jobReference.jobId;
  if (!jobId) throw new Error('[BQ] jobId が取得できませんでした（staging DROP）');

  const MAX_POLL = 30;
  for (let poll = 0; !response.jobComplete && poll < MAX_POLL; poll++) {
    Logger.log('[BQ] staging DROP 実行中... ポーリング ' + (poll + 1) + '/' + MAX_POLL);
    Utilities.sleep(2000);
    response = BigQuery.Jobs.getQueryResults(projectId, jobId, { timeoutMs: 10000, location: location });
    if (response.errors && response.errors.length > 0) {
      throw new Error(
        '[BQ] staging テーブルの DROP に失敗しました（ポーリング中、テーブル名: ' + stagingTableId +
        '）。手動で DROP してください。詳細: ' + JSON.stringify(response.errors)
      );
    }
  }

  if (!response.jobComplete) {
    throw new Error('[BQ] staging DROP がタイムアウトしました（jobId: ' + jobId + '）。手動で DROP してください。');
  }
  Logger.log('[BQ] staging テーブル DROP 完了: ' + stagingTableId);
}