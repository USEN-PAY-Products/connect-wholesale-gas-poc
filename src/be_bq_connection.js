// =============================================================================
// be_bq_connection.js
//
// BigQuery への書き込み接続ロジック（tabledata.insertAll）を管理するファイル。
//
// 依存: be_config.js（getConfig_）
//
// 公開する内部関数（末尾アンダースコア）:
//   insertInvoiceRows_(bqPayload, csvUrl) … 3テーブルへの一括登録
//   insertRows_(projectId, datasetId, tableId, rows) … 汎用insertAllラッパー
// =============================================================================

/**
 * BQ 3テーブル（wholesaler_invoices / merchant_invoices / invoice_lines）に
 * 一括登録する。csv_url は Drive 保存後の実 URL を渡すこと。
 *
 * @param {Object} bqPayload - renderConfirmPage() が組み立てたペイロード
 *   @param {Object}        bqPayload.wholesalerInvoiceRow  - 親テーブル行
 *   @param {Array<Object>} bqPayload.merchantInvoiceRows   - 子テーブル行配列
 *   @param {Array<Object>} bqPayload.invoiceLineRows       - 孫テーブル行配列
 * @param {string} csvUrl - Drive 保存後の CSV ファイル URL
 * @throws {Error} insertAll 失敗時
 */
function insertInvoiceRows_(bqPayload, csvUrl) {
  const config    = getConfig_();
  const projectId = config.gcpProjectId;
  const datasetId = config.bqDatasetId;

  // csv_url を Drive 保存後の実 URL にセット
  bqPayload.wholesalerInvoiceRow.wholesaler_invoice_csv_url = csvUrl;

  Logger.log('[BQ] wholesalerInvoiceRow: ' + JSON.stringify(bqPayload.wholesalerInvoiceRow));
  Logger.log('[BQ] merchantInvoiceRows件数: ' + (bqPayload.merchantInvoiceRows || []).length);
  Logger.log('[BQ] invoiceLineRows件数: '     + (bqPayload.invoiceLineRows     || []).length);

  // 1. wholesaler_invoices（親）
  insertRows_(projectId, datasetId, 'wholesaler_invoices', [bqPayload.wholesalerInvoiceRow]);

  // 2. merchant_invoices（子）
  if (bqPayload.merchantInvoiceRows && bqPayload.merchantInvoiceRows.length > 0) {
    insertRows_(projectId, datasetId, 'merchant_invoices', bqPayload.merchantInvoiceRows);
  }

  // 3. invoice_lines（孫）
  if (bqPayload.invoiceLineRows && bqPayload.invoiceLineRows.length > 0) {
    insertRows_(projectId, datasetId, 'invoice_lines', bqPayload.invoiceLineRows);
  }
}

/**
 * BigQuery tabledata.insertAll を呼び出す汎用ヘルパー。
 * insertErrors があれば詳細メッセージ付きで例外をスローする。
 *
 * @param {string}         projectId
 * @param {string}         datasetId
 * @param {string}         tableId
 * @param {Array<Object>}  rows
 * @throws {Error} BQ エラー時
 */
function insertRows_(projectId, datasetId, tableId, rows) {
  const body = {
    rows: rows.map(function(row) {
      return { insertId: Utilities.getUuid(), json: row };
    }),
  };
  const response = BigQuery.Tabledata.insertAll(body, projectId, datasetId, tableId);
  if (response.insertErrors && response.insertErrors.length > 0) {
    const details = response.insertErrors.map(function(e) {
      return 'row[' + e.index + ']: ' + e.errors.map(function(err) {
        return err.reason + ' - ' + err.message;
      }).join(', ');
    }).join(' | ');
    throw new Error('[BQ] ' + tableId + ' の登録エラー: ' + details);
  }
}
