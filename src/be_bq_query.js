// =============================================================================
// be_bq_query.js
//
// BigQuery からのデータ取得クエリロジックを管理するファイル。
// BackOffice API 実装後に、fetchInvoices / fetchInvoiceDetail の
// モック実装をここの BQ クエリ実装に差し替える。
//
// 依存: be_config.js（getConfig_）
//
// 公開する内部関数（末尾アンダースコア）:
//   fetchInvoicesByWholesaler_(wholesalerId) … 卸IDに紐づく請求一覧を取得
//   fetchInvoiceDetail_(invoiceId)           … 請求IDに紐づく明細を取得
//   runQuery_(sql, params)                   … 汎用クエリ実行ラッパー
// =============================================================================

/**
 * 卸業者IDに紐づく請求一覧を BQ から取得する。
 * TODO: BackOffice API 実装後に fetchInvoices() からこの関数を呼び出す。
 *
 * @param {string} wholesalerId - 卸業者ID
 * @returns {Array<Object>} 請求一覧行の配列
 * @throws {Error} クエリ失敗時
 */
function fetchInvoicesByWholesaler_(wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  wholesaler_invoice_id, wholesaler_invoice_date, wholesaler_name, ' +
    '  wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount, ' +
    '  invoice_fee_rate, invoice_fee_amount, payment_amount ' +
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
 * 請求IDに紐づく加盟店別明細を BQ から取得する。
 * TODO: BackOffice API 実装後に fetchInvoiceDetail() からこの関数を呼び出す。
 *
 * @param {string|number} invoiceId - 請求管理番号（wholesaler_invoice_id）
 * @returns {Array<Object>} 明細行の配列
 * @throws {Error} クエリ失敗時
 */
function fetchInvoiceDetail_(invoiceId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  mi.mall_code, mi.customer_code, mi.merchant_name, mi.slip_number, ' +
    '  mi.tax_amount, mi.total_ex_tax_8, mi.total_ex_tax_10, ' +
    '  il.transaction_date, il.item_name, il.unit_price, il.quantity, ' +
    '  il.quantity_unit, il.tax_rate, il.amount_ex_tax, il.tax_amount AS line_tax_amount, ' +
    '  il.invoice_detail_remark ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.merchant_invoices` AS mi ' +
    'JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.invoice_lines` AS il ' +
    '  ON mi.wholesaler_invoice_id = il.wholesaler_invoice_id ' +
    '  AND mi.mall_code = il.mall_code AND mi.slip_number = il.slip_number ' +
    'WHERE mi.wholesaler_invoice_id = @invoice_id ' +
    'ORDER BY mi.mall_code, il.transaction_date';

  const params = [
    { name: 'invoice_id', parameterType: { type: 'STRING' }, parameterValue: { value: String(invoiceId) } },
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
  var response = BigQuery.Jobs.query(request, projectId);

  if (response.errors && response.errors.length > 0) {
    throw new Error('[BQ] クエリエラー: ' + JSON.stringify(response.errors));
  }

  const jobId = response.jobReference && response.jobReference.jobId;
  if (!jobId) {
    throw new Error('[BQ] jobId が取得できませんでした');
  }

  // ── ② jobComplete=false の場合はポーリング（最大30回 = 最大5分待機）──────
  var MAX_POLL = 30;
  for (var poll = 0; !response.jobComplete && poll < MAX_POLL; poll++) {
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
  var allBqRows = response.rows || [];
  var pageToken = response.pageToken;

  while (pageToken) {
    Logger.log('[BQ] 追加ページ取得中... 取得済み行数: ' + allBqRows.length);
    var nextPage = BigQuery.Jobs.getQueryResults(projectId, jobId, { pageToken: pageToken });
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
