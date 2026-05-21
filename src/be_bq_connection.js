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
 * insertId は「wholesaler_invoice_id + テーブル名 + 行インデックス」から生成する。
 * これにより送信リトライや再実行時でも同一リクエストに同一 insertId が付与され、
 * BQ の重複排除（best-effort deduplication）が機能する。
 *
 * @param {string}         projectId
 * @param {string}         datasetId
 * @param {string}         tableId
 * @param {Array<Object>}  rows
 * @throws {Error} BQ エラー時
 */
function insertRows_(projectId, datasetId, tableId, rows) {
  // BQ insertAll の上限（1万行）を超えないよう 5,000 行ずつバッチ分割する。
  // 1加盟店最大1,000行 × 5加盟店 = 5,000行/バッチが目安。
  var BATCH_SIZE = 5000;
  for (var batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    var batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
    var body = {
      rows: batch.map(function(row, idx) {
        // 親テーブルは row.id（UUID）、子・孫テーブルは row.wholesaler_invoice_id（同UUID）を使う。
        // どちらも未設定の場合は呼び出し元（sendInvoiceData）のバグなので例外にする。
        var invoiceId = row.id || row.wholesaler_invoice_id;
        if (!invoiceId) {
          throw new Error(
            '[BQ] insertId の生成に必要な id / wholesaler_invoice_id が row[' + (batchStart + idx) + '] に存在しません。' +
            ' テーブル: ' + tableId
          );
        }
        // insertId にバッチ開始オフセットを含めることで全行ユニークを保証する
        var insertId = invoiceId + '_' + tableId + '_' + (batchStart + idx);
        return { insertId: insertId, json: row };
      }),
    };
    var response = BigQuery.Tabledata.insertAll(body, projectId, datasetId, tableId);
    if (response.insertErrors && response.insertErrors.length > 0) {
      var details = response.insertErrors.map(function(e) {
        return 'row[' + (batchStart + e.index) + ']: ' + e.errors.map(function(err) {
          return err.reason + ' - ' + err.message;
        }).join(', ');
      }).join(' | ');
      throw new Error('[BQ] ' + tableId + ' の登録エラー（バッチ開始行: ' + batchStart + '）: ' + details);
    }
    Logger.log('[BQ] ' + tableId + ' バッチ登録完了: ' + batchStart + '〜' + (batchStart + batch.length - 1) + '行目');
  }
}
