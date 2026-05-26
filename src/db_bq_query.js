// =============================================================================
// db_bq_query.js
//
// BigQuery からのデータ取得クエリロジックを管理するファイル。
//
// 依存: be_config.js（getConfig_）
//
// 公開する内部関数（末尾アンダースコア）:
//   fetchAccountInfoByEmail_(email)          … メールアドレスからアカウント情報を取得
//   fetchInvoicesByWholesaler_(wholesalerId) … 卸IDに紐づく請求一覧を取得
//   fetchInvoiceDetail_(invoiceId)           … 請求IDに紐づく明細を取得
//   runQuery_(projectId, sql, params)        … 汎用クエリ実行ラッパー
// =============================================================================

/**
 * メールアドレスからアカウント情報を BQ から取得して集約されたオブジェクトを返す。
 * wholesaler_user → wholesalers → wholesaler_merchants → store を JOIN。
 * 削除済みユーザー・非アクティブ卸は除外する。
 *
 * @param {string} email - GAS Session.getActiveUser().getEmail() の値
 * @returns {Object|null} アカウント情報オブジェクト。対応ユーザーがいない場合は null。
 * @throws {Error} クエリ失敗時
 */
function fetchAccountInfoByEmail_(email) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  wu.id                   AS wholesaler_user_id, ' +
    '  wu.wholesaler_id, ' +
    '  w.wholesaler_name, ' +
    '  w.wholesaler_fee_rate   AS fee_rate, ' +
    '  w.tax_rounding_method, ' +
    '  w.csv_format_rules, ' +
    '  wm.customer_code, ' +
    '  wm.mall_code, ' +
    '  s.store_name ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_user` AS wu ' +
    'JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesalers` AS w ' +
    '  ON w.id = wu.wholesaler_id AND w.wholesaler_status = \'active\' ' +
    'LEFT JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_merchants` AS wm ' +
    '  ON wm.wholesaler_id = wu.wholesaler_id AND wm.deleted_at IS NULL ' +
    'LEFT JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store` AS s ' +
    '  ON s.mall_code = wm.mall_code AND s.store_status = \'active\' ' +
    'WHERE wu.wholesaler_email = @email ' +
    '  AND wu.deleted_at IS NULL';

  const params = [
    { name: 'email', parameterType: { type: 'STRING' }, parameterValue: { value: email } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  if (!rows || rows.length === 0) return null;

  const first = rows[0];
  const merchantMappings = rows
    .filter(function(r) { return r.mall_code; })
    .map(function(r) {
      return { customer_code: r.customer_code, mall_code: r.mall_code, store_name: r.store_name };
    });

  return {
    wholesaler_id:       Number(first.wholesaler_id),
    wholesaler_user_id:  first.wholesaler_user_id,
    wholesaler_name:     first.wholesaler_name,
    fee_rate:            Number(first.fee_rate),
    tax_rounding_method: first.tax_rounding_method,
    csv_format_rules:    (function() {
      try {
        return first.csv_format_rules ? JSON.parse(first.csv_format_rules) : null;
      } catch (e) {
        Logger.log('[fetchAccountInfoByEmail_] csv_format_rules のパースに失敗しました。デフォルトフォーマットを使用します: ' + e.message);
        return null;
      }
    })(),
    merchant_mappings:   merchantMappings,
  };
}

/**
 * 卸業者IDに紐づく請求一覧を BQ から取得する。
 *
 * @param {number} wholesalerId - 卸業者ID
 * @returns {Array<Object>} 請求一覧行の配列
 * @throws {Error} クエリ失敗時
 */
function fetchInvoicesByWholesaler_(wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  id AS wholesaler_invoice_id, wholesaler_invoice_date, ' +
    '  wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount, ' +
    '  wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount, ' +
    '  wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount, ' +
    '  wholesaler_non_taxable_amount, ' +
    '  wholesaler_fee_rate, invoice_fee_amount, payment_amount ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices` ' +
    'WHERE wholesaler_id = @wholesaler_id ' +
    'ORDER BY wholesaler_invoice_date DESC ' +
    'LIMIT 100';

  const params = [
    { name: 'wholesaler_id', parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
  ];

  return runQuery_(config.gcpProjectId, sql, params);
}

/**
 * 請求IDに紐づく親サマリー（wholesaler_invoices 1行）を BQ から取得する。
 * IDOR 対策: wholesaler_id を必須とし、自分の請求書のみ取得できるようにする。
 *
 * @param {string} invoiceId    - 卸インボイスID
 * @param {number} wholesalerId - ログイン中の卸業者ID
 * @returns {Object|null} 親レコード。見つからない場合は null。
 * @throws {Error} クエリ失敗時
 */
function fetchInvoiceDetailSummary_(invoiceId, wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  id, wholesaler_invoice_date, ' +
    '  wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount, ' +
    '  wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount, ' +
    '  wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount, ' +
    '  wholesaler_non_taxable_amount, ' +
    '  wholesaler_fee_rate, invoice_fee_amount, payment_amount, handover_matter ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices` ' +
    'WHERE id = @invoice_id ' +
    '  AND wholesaler_id = @wholesaler_id ' +
    'LIMIT 1';

  const params = [
    { name: 'invoice_id',    parameterType: { type: 'STRING' }, parameterValue: { value: String(invoiceId) } },
    { name: 'wholesaler_id', parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 請求IDに紐づく加盟店別サマリー（store_invoices）を BQ から取得する。
 * IDOR 対策: wholesaler_id を必須とし、自分の請求書に紐づく店舗のみ取得できるようにする。
 * RETURNED ステータスの店舗を先頭に、それ以外は mall_code 昇順で返す。
 *
 * @param {string} invoiceId    - 卸インボイスID
 * @param {number} wholesalerId - ログイン中の卸業者ID
 * @returns {Array<Object>} 加盟店サマリー行の配列
 * @throws {Error} クエリ失敗時
 */
function fetchStoreInvoicesByParent_(invoiceId, wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  si.id AS store_invoice_id, ' +
    '  si.mall_code, ' +
    '  s.store_name, ' +
    '  si.invoice_number, ' +
    '  si.backoffice_review_status, ' +
    '  si.total_amount, si.subtotal_amount, si.tax_amount, ' +
    '  si.standard_tax_target_amount, si.standard_tax_amount, ' +
    '  si.reduced_tax_target_amount, si.reduced_tax_amount, ' +
    '  si.non_taxable_amount, ' +
    '  si.backoffice_handover, si.wholesaler_handover, si.wholesaler_remark, si.backoffice_remark ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store_invoices` AS si ' +
    'LEFT JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store` AS s ' +
    '  ON s.mall_code = si.mall_code ' +
    'WHERE si.wholesaler_invoice_id = @invoice_id ' +
    '  AND si.wholesaler_id = @wholesaler_id ' +
    'ORDER BY ' +
    '  CASE si.backoffice_review_status WHEN \'RETURNED\' THEN 0 ELSE 1 END ASC, ' +
    '  si.mall_code ASC';

  const params = [
    { name: 'invoice_id',    parameterType: { type: 'STRING' }, parameterValue: { value: String(invoiceId) } },
    { name: 'wholesaler_id', parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
  ];

  return runQuery_(config.gcpProjectId, sql, params);
}

/**
 * 加盟店インボイスIDに紐づく明細（invoice_lines）を BQ から取得する（最大1000件）。
 * アコーディオンのオンデマンド読み込みに使用する。
 * IDOR 対策: store_invoices と INNER JOIN して wholesaler_id を検証する。
 *           invoice_lines には wholesaler_id カラムがなく CSV 直接 INSERT のため
 *           クエリ側で必ず所有者チェックを行う。
 *
 * @param {string} storeInvoiceId - 加盟店インボイスID
 * @param {number} wholesalerId   - ログイン中の卸業者ID
 * @returns {Array<Object>} 明細行の配列
 * @throws {Error} クエリ失敗時
 */
function fetchInvoiceLinesByStore_(storeInvoiceId, wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  il.invoice_item_row, il.transaction_date, il.item_name, ' +
    '  il.quantity, il.quantity_unit, il.unit_price, il.tax_category, ' +
    '  il.line_amount_excluding_tax, il.line_tax_amount, il.line_note ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.invoice_lines` AS il ' +
    'INNER JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store_invoices` AS si ' +
    '  ON si.id = il.store_invoice_id ' +
    ' AND si.wholesaler_id = @wholesaler_id ' +
    'WHERE il.store_invoice_id = @store_invoice_id ' +
    'ORDER BY il.invoice_item_row ASC ' +
    'LIMIT 1000';

  const params = [
    { name: 'store_invoice_id', parameterType: { type: 'STRING' }, parameterValue: { value: String(storeInvoiceId) } },
    { name: 'wholesaler_id',    parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
  ];

  return runQuery_(config.gcpProjectId, sql, params);
}

/**
 * BigQuery Jobs.query を呼び出す汎用クエリ実行ヘルパー。
 * 結果行を Object の配列として返す。
 *
 * @param {string}         projectId
 * @param {string}         sql        - パラメータ化クエリ文字列（@param_name 形式）
 * @param {Array<Object>}  [params]   - queryParameters 配列（省略可）
 * @returns {Array<Object>} 結果行の配列（カラム名をキーとしたオブジェクト）
 * @throws {Error} クエリエラー時
 */
function runQuery_(projectId, sql, params) {
  const request = {
    query:           sql,
    useLegacySql:    false,
    timeoutMs:       10000, // 1回あたり10秒待機（jobComplete=false なら繰り返す）
    queryParameters: params || [],
  };

  // ── ① ジョブ投入 ─────────────────────────────────────────────────────────
  let response = BigQuery.Jobs.query(request, projectId);

  if (response.errors && response.errors.length > 0) {
    throw new Error('[BQ] クエリエラー: ' + JSON.stringify(response.errors));
  }

  const jobId = response.jobReference && response.jobReference.jobId;
  if (!jobId) {
    throw new Error('[BQ] jobId が取得できませんでした');
  }

  // ── ② jobComplete=false の場合はポーリング（最大30回 = 最大5分待機）──────
  const MAX_POLL = 30;
  for (let poll = 0; !response.jobComplete && poll < MAX_POLL; poll++) {
    Logger.log('[BQ] クエリ実行中... ポーリング ' + (poll + 1) + '/' + MAX_POLL);
    Utilities.sleep(2000); // 2秒待機してから再取得
    response = BigQuery.Jobs.getQueryResults(projectId, jobId, { timeoutMs: 10000 });
    if (response.errors && response.errors.length > 0) {
      throw new Error('[BQ] クエリエラー（ポーリング中）: ' + JSON.stringify(response.errors));
    }
  }

  if (!response.jobComplete) {
    throw new Error('[BQ] クエリがタイムアウトしました（jobId: ' + jobId + '）');
  }

  // ── ③ 全ページ取得（pageToken がある限りループ）─────────────────────────
  const schema = (response.schema && response.schema.fields) || [];
  let allBqRows = response.rows || [];
  let pageToken = response.pageToken;

  while (pageToken) {
    Logger.log('[BQ] 追加ページ取得中... 取得済み行数: ' + allBqRows.length);
    const nextPage = BigQuery.Jobs.getQueryResults(projectId, jobId, { pageToken: pageToken });
    if (nextPage.errors && nextPage.errors.length > 0) {
      throw new Error('[BQ] ページング中エラー: ' + JSON.stringify(nextPage.errors));
    }
    allBqRows = allBqRows.concat(nextPage.rows || []);
    pageToken = nextPage.pageToken;
  }

  Logger.log('[BQ] クエリ完了。取得行数: ' + allBqRows.length);

  // ── ④ rows を {カラム名: 値} のオブジェクト配列に変換 ────────────────────
  return allBqRows.map(function(row) {
    const obj = {};
    (row.f || []).forEach(function(cell, idx) {
      obj[schema[idx].name] = cell.v;
    });
    return obj;
  });
}
