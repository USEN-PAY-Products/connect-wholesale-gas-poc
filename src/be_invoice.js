// =============================================================================
// be_invoice.js
//
// 請求データ関連の公開関数（フロントから google.script.run で呼ばれる）を管理する。
//
// 公開関数:
//   sendInvoiceData(csvBase64, bqPayload)
//   fetchInvoices()
//   fetchInvoiceDetail(invoiceId)
//   getMockScheduleData()    ← BackOffice API 実装後に削除
//   getMockBillingHistory()  ← BackOffice API 実装後に削除
//
// 依存:
//   be_config.js        … getConfig_()
//   be_utils.js         … success_(), getOrCreateSubFolder_(), formatTimestamp_(), formatYearMonth_()
//   be_bq_connection.js … insertInvoiceRows_()
//   be_bq_query.js      … fetchInvoicesByWholesaler_(), fetchInvoiceDetail_()
// =============================================================================

// =============================================================================
// 請求登録
// =============================================================================

/**
 * CSV を Drive に保存し、BigQuery の 3 テーブルに登録する。
 * Drive フォルダ構造: <DRIVE_ROOT> / <wholesaler_id> / <YYYYMM> / <タイムスタンプ>_original.csv
 * フォルダ名に卸業者名でなく ID を使用することで、卸名変更時でも監査証跡が分散しない。
 *
 * 【セキュリティ】卸情報（wholesaler_id / wholesaler_name など）はサーバー側の
 * getServerAccountInfo_() から取得し、フロントから受け取った bqPayload 内の値は
 * 上書きする。wholesaler_id が一致しない場合は処理を中断する。
 *
 * @param {string} csvBase64  - 元CSVのBase64エンコード文字列
 * @param {Object} bqPayload  - フロントが組み立てた BQ 登録用ペイロード
 * @returns {{ status: 'success', data: { csv_url: string } }}
 * @throws {Error} Drive 操作または BQ 書き込み失敗時
 */
function sendInvoiceData(csvBase64, bqPayload) {
  try {
    // ── サーバー側から卸情報を取得（改ざん不可）──────────────────────────
    const accountInfo    = getServerAccountInfo_();
    const serverWsId     = Number(accountInfo.wholesaler_id);
    const serverWsUserId = Number(accountInfo.wholesaler_user_id);
    const serverWsName   = String(accountInfo.wholesaler_name || '不明');

    // ── BQ ペイロードの存在確認と wholesaler_id 検証 ─────────────────────
    if (!bqPayload) {
      throw new Error('bqPayload が null です。確認画面を開き直してから再送信してください。');
    }
    const clientWsId = Number((bqPayload.wholesalerInvoiceRow || {}).wholesaler_id);
    if (clientWsId !== serverWsId) {
      throw new Error(
        'wholesaler_id の不一致: client=' + clientWsId + ', server=' + serverWsId
      );
    }

    // ── サーバー値でペイロード内の卸情報を全行上書き（改ざん防止）───
    // 親テーブル（wholesaler_invoices）
    bqPayload.wholesalerInvoiceRow.wholesaler_id        = serverWsId;
    bqPayload.wholesalerInvoiceRow.wholesaler_user_id   = serverWsUserId;
    bqPayload.wholesalerInvoiceRow.wholesaler_name      = serverWsName;
    // 子テーブル（merchant_invoices）―各行の wholesaler_id もサーバー値で上書き
    const wholesalerInvoiceId = bqPayload.wholesalerInvoiceRow.wholesaler_invoice_id;
    (bqPayload.merchantInvoiceRows || []).forEach(function(row) {
      row.wholesaler_id         = serverWsId;
      row.wholesaler_invoice_id = wholesalerInvoiceId;
    });
    // 孫テーブル（invoice_lines）― wholesaler_invoice_id をサーバー値で上書き
    (bqPayload.invoiceLineRows || []).forEach(function(row) {
      row.wholesaler_invoice_id = wholesalerInvoiceId;
    });

    const config = getConfig_();
    const now    = new Date();

    // ── Drive 保存（元バイト列のまま保存）─────────────────────────────────────
    // フォルダ名に卸業者名でなく wholesaler_id を使用（卸名変更でも監査証跡が分散しない）
    const rootFolder  = DriveApp.getFolderById(config.driveFolderId);
    const userFolder  = getOrCreateSubFolder_(rootFolder, String(serverWsId));
    const monthFolder = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName    = formatTimestamp_(now) + '_original.csv';
    const csvBytes    = Utilities.base64Decode(csvBase64);
    const csvBlob     = Utilities.newBlob(csvBytes, MimeType.CSV, fileName);
    const csvFile     = monthFolder.createFile(csvBlob);
    const csvUrl      = csvFile.getUrl();

    // ── STUB MODE: Drive 保存のみ、BQ 書き込みスキップ ─────────────────────
    if (STUB_MODE) {
      Logger.log('[STUB] Drive 保存完了: ' + csvUrl);
      Logger.log('[STUB] BQ 書き込みはスキップします（テーブル未作成）');
      return success_({ csv_url: csvUrl });
    }

    // ── BQ 登録（be_bq_connection.js に委譲）──────────────────────────────
    Logger.log('[BQ] 登録開始: wholesalerId=' + serverWsId + ', wholesalerName=' + serverWsName);
    insertInvoiceRows_(bqPayload, csvUrl);

    return success_({ csv_url: csvUrl });
  } catch (err) {
    throw new Error('sendInvoiceData failed: ' + err.message);
  }
}

// =============================================================================
// 請求一覧取得
// TODO: バックオフィスAPI実装後に fetchInvoicesByWholesaler_() に差し替える
// =============================================================================

/**
 * ログインユーザーの請求一覧を返す。
 * 現在はモックデータを返す。BackOffice API 実装後に be_bq_query.js の
 * fetchInvoicesByWholesaler_() を呼び出す実装に差し替えること。
 *
 * @returns {{ status: 'success', data: Array<Object> }}
 */
function fetchInvoices() {
  try {
    // TODO: return success_(fetchInvoicesByWholesaler_(getWholesalerId_()));
    return getMockBillingHistory();
  } catch (err) {
    throw new Error('fetchInvoices failed: ' + err.message);
  }
}

// =============================================================================
// 請求詳細取得
// TODO: バックオフィスAPI実装後に fetchInvoiceDetail_() に差し替える
// =============================================================================

/**
 * 指定した請求IDの詳細データを返す。
 * 現在は null を返す（詳細画面未実装）。BackOffice API 実装後に
 * be_bq_query.js の fetchInvoiceDetail_() を呼び出す実装に差し替えること。
 *
 * @param {string|number} invoiceId - 取得対象の請求管理番号
 * @returns {{ status: 'success', data: Object|null }}
 */
function fetchInvoiceDetail(invoiceId) {
  try {
    // TODO: return success_(fetchInvoiceDetail_(invoiceId));
    return success_(null);
  } catch (err) {
    throw new Error('fetchInvoiceDetail failed: ' + err.message);
  }
}

// =============================================================================
// モックデータ定数  ── BackOffice API 実装後に削除する
// ※ フロント側フォールバック（fe_js.html 内の home.js）と同一形式を維持すること
// =============================================================================

/** @type {Array<{date:string, title:string, type:string}>} */
var MOCK_SCHEDULE_ = [
  { date: '2026-05-13', title: '請求確定', type: 'billing' },
  { date: '2026-05-27', title: '口座振替', type: 'payment' },
];

/** 請求履歴1件分の共通フィールド。id / monthLabel は各エントリで上書きする。 */
var MOCK_BILLING_BASE_ = {
  billingAmount: 99999999,
  subtotalExTax: 90000000,
  taxAmount:     9999999,
  breakdown: [
    { rate: 10, subtotalExTax: 49999999, taxAmount: 4999999 },
    { rate: 8,  subtotalExTax: 50000000, taxAmount: 4000000 },
  ],
  fee:            9999999,
  transferAmount: 990000000,
  status:        '支払完了',
};

/** @type {Array<{id:string, monthLabel:string}>} */
var MOCK_BILLING_ENTRIES_ = [
  { id: 'b001', monthLabel: '4月' },
  { id: 'b002', monthLabel: '3月' },
  { id: 'b003', monthLabel: '2月' },
  { id: 'b004', monthLabel: '1月' },
];

// =============================================================================
// モック公開関数  ── BackOffice API 実装後に削除する
// =============================================================================

/**
 * スケジュールデータのモックを返す。
 * @returns {{ status: 'success', data: Array }}
 */
function getMockScheduleData() {
  try {
    return success_(MOCK_SCHEDULE_);
  } catch (err) {
    throw new Error('getMockScheduleData failed: ' + err.message);
  }
}

/**
 * 請求履歴のモックを返す。
 * @returns {{ status: 'success', data: Array }}
 */
function getMockBillingHistory() {
  try {
    const items = MOCK_BILLING_ENTRIES_.map(function(entry) {
      return Object.assign({}, MOCK_BILLING_BASE_, entry);
    });
    return success_(items);
  } catch (err) {
    throw new Error('getMockBillingHistory failed: ' + err.message);
  }
}

// =============================================================================
// テスト用関数  ── 動作確認が終わったら削除してOK
// =============================================================================

/**
 * sendInvoiceData の動作確認用。
 * Script Property "ENV" が "development" のときのみ実行可能。
 *
 * ※ サーバー側で getServerAccountInfo_() を呼ぶため、STUB_ACCOUNT_INFO_MODE=true の
 *   場合は STUB_ACCOUNT_INFO の wholesaler_id（=1）と一致するペイロードを渡すこと。
 */
function testSendInvoice_() {
  const env = PropertiesService.getScriptProperties().getProperty('ENV');
  if (env !== 'development') {
    throw new Error('testSendInvoice_() は development 環境でのみ実行できます (ENV=' + env + ')');
  }
  const dummyCsv = '加盟店コード,日付,品目,数量,単価,税率区分(%),請求金額（税抜）,備考\r\nC001,2026-05-01,テスト品目,1,1000,10,1000,\r\n';
  const dummyBase64 = Utilities.base64Encode(dummyCsv);
  // STUB_ACCOUNT_INFO の wholesaler_id=1 と一致させる
  const dummyBqPayload = {
    wholesalerInvoiceRow: {
      wholesaler_id:              1,
      wholesaler_user_id:         1,
      wholesaler_name:            'テスト卸',
      wholesaler_invoice_id:      null,
      wholesaler_invoice_date:    '2026-05-20',
      wholesaler_total_amount:    1100,
      wholesaler_subtotal_amount: 1000,
      wholesaler_tax_amount:      100,
      wholesaler_total_ex_tax_8:  0,
      wholesaler_total_ex_tax_10: 1000,
      invoice_fee_rate:           5,
      invoice_fee_amount:         55,
      payment_amount:             1045,
      handover_matter:            '',
      wholesaler_invoice_csv_url: '',
    },
    merchantInvoiceRows: [],
    invoiceLineRows:     [],
  };
  const result = sendInvoiceData(dummyBase64, dummyBqPayload);
  Logger.log('テスト結果: ' + JSON.stringify(result));
}
