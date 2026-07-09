// =============================================================================
// test/be_invoice.test.js
//
// 一括再請求（bulkResubmitInvoiceData）における wholesaler_invoices 金額再計算の
// ユニットテスト（MYP-4204 バグ対応part10）。
//
// バグ概要:
//   要対応（差し戻し・否認）の加盟店が複数（例: C001, C003）ある状態で、
//   CSVに一部の加盟店（C001）のみを含めて一括アップロードすると、
//   CSVに含まれない要対応の加盟店（C003）の金額まで誤って
//   wholesaler_invoices の再計算（旧金額の差し引き）対象に含まれてしまい、
//   詳細画面ヘッダーの金額表示が全てズレる不具合があった。
//
//   原因は fetchTargetStoreInvoiceAmounts_ の第3引数（storeInvoiceIds）に
//   null を渡していたため、「CSVに含まれる加盟店」ではなく「要対応の全加盟店」の
//   旧金額が差し引かれていたこと。本テストは、その第3引数が
//   「CSVに実際に含まれる加盟店の store_invoice_id のみ」に正しく絞り込まれている
//   ことを検証する。
//
// src/be_invoice.js を「未改変のまま」vm サンドボックスへ読み込み、
// be_server.js・be_config.js・be_csv_mapper.js・db_bq_connection.js・db_bq_query.js・
// be_utils.js 側の依存関数は全てサンドボックス上の直接スタブに差し替えて検証する
// （test/be_slack.test.js と同じ vm.createContext + vm.runInContext 方式。
//  対象ソースへ module.exports 等を追加することは禁止のため require() は使わない）。
//
// 検証内容:
//   1. CSVに一部の加盟店（C001）のみ含む一括再請求で、fetchTargetStoreInvoiceAmounts_ の
//      storeInvoiceIds 引数が「CSVに含まれる加盟店（C001）の store_invoice_id のみ」になり、
//      CSVに含まれない要対応の加盟店（C003）の store_invoice_id を含まないこと（null でもないこと）
//   2. CSVに要対応の全加盟店（C001, C003）を含む一括再請求では、両方の store_invoice_id が
//      正しく含まれること（絞り込みが CSV 対象加盟店を過剰除外していないことの確認）
//   3. 万一 CSV 対象加盟店の store_invoice_id が解決できない（DBデータ不整合）場合は、
//      黙って「全要対応」にフォールバックせず明示的にエラーを投げること（安全策）
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BE_INVOICE_PATH = path.join(__dirname, '..', 'src', 'be_invoice.js');
const BE_INVOICE_SRC = fs.readFileSync(BE_INVOICE_PATH, 'utf8');

const CSV_HEADER = '顧客コード,日付,品目,数量,単価,税率区分(%),請求金額（税抜）,消費税,備考';

/**
 * デフォルト9列フォーマットのCSVテキストを組み立てる。
 *
 * @param {string[]} rows - ヘッダーを除くデータ行（カンマ区切り済み文字列）の配列
 * @returns {string}
 */
function buildCsvText(rows) {
  return [CSV_HEADER].concat(rows).join('\n');
}

/**
 * fetchStoreInvoicesByParent_ の戻り値1行分を組み立てる。
 *
 * @param {string} customerCode
 * @param {string} mallCode
 * @param {string} storeInvoiceId - 空文字を渡すと「store_invoice_id が解決できない」不整合データを再現できる
 * @param {Object} [extra] - 追加・上書きしたいフィールド
 * @returns {Object}
 */
function makeStoreRow(customerCode, mallCode, storeInvoiceId, extra) {
  return Object.assign({
    store_invoice_id: storeInvoiceId,
    mall_code: mallCode,
    store_name: '加盟店' + customerCode,
    store_status: 'active',
    wholesaler_managed_store_name: '',
    customer_code: customerCode,
    backoffice_review_status: 'RETURNED',
    invoice_status: '',
    store_disputed_reason: '',
  }, extra || {});
}

/**
 * GAS のグローバル API・他ファイル（be_server.js/be_config.js/be_csv_mapper.js/
 * db_bq_connection.js/db_bq_query.js/be_utils.js）の依存関数をスタブした
 * vm サンドボックスを作成し、src/be_invoice.js を未改変のまま読み込んで返す。
 *
 * @param {Object} [options]
 * @param {Array<{mall_code: string, invoice_status: string}>} [options.actionRequiredRows]
 *   fetchActionRequiredMallCodes_ の戻り値（要対応の mall_code 一覧）
 * @param {Array<Object>} [options.storeRows] - fetchStoreInvoicesByParent_ の戻り値
 * @param {Object|null} [options.latestWi] - fetchLatestWholesalerInvoice_ の戻り値（省略時はダミーの正常値）
 * @param {Object|null} [options.parentSummary] - fetchInvoiceDetailSummary_ の戻り値（異議申立期間チェック用。省略時は null）
 * @param {string} [options.wholesalerStatus] - accountInfo.wholesaler_status（既定: 'active'）
 * @returns {vm.Context & {
 *   __fetchTargetStoreInvoiceAmountsCalls: Array<{rootInvoiceId: string, wholesalerId: number, storeInvoiceIds: *}>,
 *   __runTransactionSqlCalls: Array<{projectId: string, sql: string}>,
 * }}
 */
function createSandbox(options) {
  const opts = options || {};
  const actionRequiredRows = opts.actionRequiredRows || [];
  const storeRows = opts.storeRows || [];
  const latestWi = Object.prototype.hasOwnProperty.call(opts, 'latestWi') ? opts.latestWi : {
    id: 'parent-wi-id',
    wholesaler_invoice_date: '2026-07-01',
    wholesaler_total_amount: 5000,
    wholesaler_subtotal_amount: 4500,
    wholesaler_tax_amount: 500,
    wholesaler_standard_tax_target_amount: 4500,
    wholesaler_standard_tax_amount: 500,
    wholesaler_reduced_tax_target_amount: 0,
    wholesaler_reduced_tax_amount: 0,
    wholesaler_non_taxable_amount: 0,
    wholesaler_fee_rate: 3,
    invoice_fee_amount: 150,
    payment_amount: 4850,
  };
  const parentSummary = Object.prototype.hasOwnProperty.call(opts, 'parentSummary') ? opts.parentSummary : null;

  // cancelWithdrawRequest 用スタブの戻り値（デフォルトは「取り消し可能な正常系」。
  // 個別テストで opts 経由で上書きし、対象なし・期間切れ等の分岐を再現する）。
  const cancelWithdrawStoreRow = Object.prototype.hasOwnProperty.call(opts, 'cancelWithdrawStoreRow')
    ? opts.cancelWithdrawStoreRow
    : { id: 'dummy-store-invoice-id', invoice_status: 'DISPUTED', backoffice_review_status: 'WITHDRAW_REQUESTED' };
  // デフォルトは business_calendar に該当行なし（= 異議申立期間の制限なし）。
  const objectionPeriodRow = Object.prototype.hasOwnProperty.call(opts, 'objectionPeriodRow')
    ? opts.objectionPeriodRow
    : null;

  const fetchTargetStoreInvoiceAmountsCalls = [];
  const runTransactionSqlCalls = [];
  const mappedSqlCalls = [];
  const logErrorCalls = [];

  const sandbox = {
    console: console,

    Logger: { log: function () {} },
    MimeType: { CSV: 'text/csv' },
    Utilities: {
      base64Decode: function (s) { return s; },
      newBlob: function (bytes) { return { getDataAsString: function () { return bytes; } }; },
      getUuid: function () { return '00000000-0000-0000-0000-000000000000'; },
      formatDate: function () { return '2026-07-07'; },
    },
    DriveApp: {
      getFolderById: function () { return {}; },
    },

    // ── be_utils.js 相当のスタブ ──
    logInfo_: function () {},
    logError_: function (domain, action, err, context) {
      logErrorCalls.push({ domain: domain, action: action, err: err, context: context });
    },
    success_: function (data) { return { status: 'success', data: data }; },
    error_: function (message, data) { return { status: 'error', message: message, data: data || null }; },
    getOrCreateSubFolder_: function () {
      return {
        createFile: function () {
          return { getUrl: function () { return 'https://drive.example.test/dummy.csv'; } };
        },
      };
    },
    formatYearMonth_: function () { return '202607'; },
    formatTimestamp_: function () { return '20260707120000'; },

    // ── be_config.js 相当のスタブ ──
    getConfig_: function () {
      return {
        gcpProjectId: 'test-project',
        bqDatasetId: 'test_dataset',
        bqLocation: 'US',
        driveFolderId: 'test-drive-folder-id',
      };
    },

    // ── be_server.js 相当のスタブ ──
    getServerAccountInfo_: function () {
      return {
        wholesaler_id: 123,
        wholesaler_user_id: 'user-uuid-0000',
        wholesaler_name: 'テスト卸',
        wholesaler_status: opts.wholesalerStatus || 'active',
        csv_format_rules: null,
        fee_rate: 3,
        tax_rounding_method: 'floor',
      };
    },

    // ── be_csv_mapper.js 相当のスタブ（デフォルトCSV形式のテストのため isNewFormatRules_ は常に false 想定）──
    isNewFormatRules_: function (rules) { return !!(rules && Array.isArray(rules.columns) && rules.columns.length > 0); },
    validateCsvHeaderByRules_: function () {},
    buildMappedBulkResubmitTransactionSql_: function (params) {
      mappedSqlCalls.push(params);
      return 'DUMMY MAPPED SQL';
    },

    // ── db_bq_connection.js 相当のスタブ ──
    loadCsvToBq_: function () { return 'fake-job-id'; },
    waitForLoadJob_: function () {},
    runTransactionSql_: function (projectId, sql) { runTransactionSqlCalls.push({ projectId: projectId, sql: sql }); },
    dropStagingTable_: function () {},

    // ── db_bq_query.js 相当のスタブ ──
    fetchInvoiceDetailSummary_: function () { return parentSummary; },
    fetchActionRequiredMallCodes_: function () { return actionRequiredRows; },
    fetchStoreInvoicesByParent_: function () { return storeRows; },
    fetchStoreInvoiceMallCode_: function (storeInvoiceId) {
      const row = storeRows.find(function (r) { return String(r.store_invoice_id) === String(storeInvoiceId); });
      return row ? row.mall_code : null;
    },
    fetchLatestWholesalerInvoice_: function () { return latestWi; },
    fetchStoreInvoiceForCancelWithdrawRequest_: function () { return cancelWithdrawStoreRow; },
    fetchObjectionPeriodEndDate_: function () { return objectionPeriodRow; },
    fetchTargetStoreInvoiceAmounts_: function (rootInvoiceId, wholesalerId, storeInvoiceIds) {
      fetchTargetStoreInvoiceAmountsCalls.push({
        rootInvoiceId: rootInvoiceId,
        wholesalerId: wholesalerId,
        storeInvoiceIds: storeInvoiceIds,
      });
      return { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(BE_INVOICE_SRC, sandbox, { filename: 'be_invoice.js' });

  sandbox.__fetchTargetStoreInvoiceAmountsCalls = fetchTargetStoreInvoiceAmountsCalls;
  sandbox.__runTransactionSqlCalls = runTransactionSqlCalls;
  sandbox.__mappedSqlCalls = mappedSqlCalls;
  sandbox.__logErrorCalls = logErrorCalls;

  return sandbox;
}

const PARENT_INVOICE_ID = '11111111-1111-1111-1111-111111111111';

// =============================================================================
// 検証1: CSVに含まれない要対応の加盟店(C003)を金額差し引き対象に含めない
// =============================================================================

test('bulkResubmitInvoiceData: CSVに含まれない要対応の加盟店(C003)を金額差し引き対象に含めない', () => {
  const storeRows = [
    makeStoreRow('CUST001', 'MALL-C001', 'SI-C001-OLD'),
    makeStoreRow('CUST003', 'MALL-C003', 'SI-C003-OLD'),
  ];
  const actionRequiredRows = [
    { mall_code: 'MALL-C001', invoice_status: '' },
    { mall_code: 'MALL-C003', invoice_status: '' },
  ];
  const sandbox = createSandbox({ storeRows: storeRows, actionRequiredRows: actionRequiredRows });

  // CSVにはC001のみ含める（C003は要対応だが今回の再請求対象外）
  const csvText = buildCsvText(['CUST001,2026/07/01,テスト商品,1,1000,10,1000,100,']);
  const summaryData = {
    wholesalerTotal: { totalAmount: 1100 }, // BE側で再計算されるため初期値はダミーでよい
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };

  const result = sandbox.bulkResubmitInvoiceData(
    'dummy-raw-csv-base64',
    csvText, // Utilities.base64Decode/newBlob をパススルーでスタブしているため、CSVテキストをそのまま渡せる
    'test.csv',
    summaryData,
    {},
    PARENT_INVOICE_ID,
    {},
    'dummy-session-token'
  );

  assert.equal(result.status, 'success');
  assert.equal(sandbox.__fetchTargetStoreInvoiceAmountsCalls.length, 1);
  // C003（CSV対象外の要対応店舗）の store_invoice_id を含んではならない。null でもない。
  assert.deepEqual(sandbox.__fetchTargetStoreInvoiceAmountsCalls[0].storeInvoiceIds, ['SI-C001-OLD']);
});

// =============================================================================
// 検証2: 要対応の全加盟店をCSVに含む場合は両方のstore_invoice_idを対象にする
// =============================================================================

test('bulkResubmitInvoiceData: 要対応の全加盟店(C001,C003)をCSVに含む場合は両方のstore_invoice_idを対象にする', () => {
  const storeRows = [
    makeStoreRow('CUST001', 'MALL-C001', 'SI-C001-OLD'),
    makeStoreRow('CUST003', 'MALL-C003', 'SI-C003-OLD'),
  ];
  const actionRequiredRows = [
    { mall_code: 'MALL-C001', invoice_status: '' },
    { mall_code: 'MALL-C003', invoice_status: '' },
  ];
  const sandbox = createSandbox({ storeRows: storeRows, actionRequiredRows: actionRequiredRows });

  const csvText = buildCsvText([
    'CUST001,2026/07/01,テスト商品,1,1000,10,1000,100,',
    'CUST003,2026/07/01,テスト商品,1,2000,10,2000,200,',
  ]);
  const summaryData = {
    wholesalerTotal: { totalAmount: 3300 },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
      { customerCode: 'CUST003', totalAmount: 2200, subtotalAmount: 2000, taxAmount: 200, exTax10: 2000, tax10: 200, exTax8: 0, tax8: 0 },
    ],
  };

  const result = sandbox.bulkResubmitInvoiceData(
    'dummy-raw-csv-base64',
    csvText,
    'test.csv',
    summaryData,
    {},
    PARENT_INVOICE_ID,
    {},
    'dummy-session-token'
  );

  assert.equal(result.status, 'success');
  assert.equal(sandbox.__fetchTargetStoreInvoiceAmountsCalls.length, 1);
  assert.deepEqual(
    sandbox.__fetchTargetStoreInvoiceAmountsCalls[0].storeInvoiceIds.slice().sort(),
    ['SI-C001-OLD', 'SI-C003-OLD']
  );
});

// =============================================================================
// 検証3: store_invoice_id が解決できない場合は「全要対応」へフォールバックせず例外を投げる
// =============================================================================

test('bulkResubmitInvoiceData: 対象加盟店のstore_invoice_idが解決できない場合は全要対応にフォールバックせず例外を投げる', () => {
  const storeRows = [
    // データ不整合を想定: mall_code はあるが store_invoice_id が空文字
    makeStoreRow('CUST001', 'MALL-C001', ''),
  ];
  const actionRequiredRows = [
    { mall_code: 'MALL-C001', invoice_status: '' },
  ];
  const sandbox = createSandbox({ storeRows: storeRows, actionRequiredRows: actionRequiredRows });

  const csvText = buildCsvText(['CUST001,2026/07/01,テスト商品,1,1000,10,1000,100,']);
  const summaryData = {
    wholesalerTotal: { totalAmount: 1100 },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };

  let thrown = null;
  try {
    sandbox.bulkResubmitInvoiceData(
      'dummy-raw-csv-base64',
      csvText,
      'test.csv',
      summaryData,
      {},
      PARENT_INVOICE_ID,
      {},
      'dummy-session-token'
    );
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, '例外が投げられるはず');
  assert.equal(thrown.message, '対象の加盟店請求情報が見つかりませんでした。ページを再読み込みしてください。');
  // 「全要対応」へのフォールバック（fetchTargetStoreInvoiceAmounts_ の呼び出し自体）が
  // 発生していないことも確認する。
  assert.equal(sandbox.__fetchTargetStoreInvoiceAmountsCalls.length, 0);
});

// =============================================================================
// 検証4〜6: wholesaler_merchants に customer_code+wholesaler_id の重複行が
//           存在していても invoice_lines が水増し登録されないこと。
//
// 背景:
//   新規アップロード・個別再請求・一括再請求の invoice_lines INSERT...SELECT は、
//   いずれも wholesaler_merchants を customer_code + wholesaler_id + deleted_at IS NULL
//   の条件で直接 JOIN していたため、同一 customer_code+wholesaler_id の
//   有効行が誤って複数登録されていた場合に JOIN の fan-out で invoice_lines が
//   重複登録される恐れがあった（store_invoices は VALUES ベースの INSERT のため
//   この問題の対象外）。
//
//   本修正では wholesaler_merchants を直接 JOIN せず、customer_code 単位で
//   registration_at が最新の1件のみに絞り込むサブクエリ
//   （ROW_NUMBER() OVER (PARTITION BY customer_code ORDER BY registration_at DESC) AS rn /
//    rn = 1）を介して JOIN するように変更した。本テストは3つの SQL 組み立て関数
//   （buildTransactionSql_ / buildResubmitTransactionSql_ /
//    buildBulkResubmitTransactionSql_）が生成する SQL 文字列に、その重複排除
//   サブクエリが含まれており、かつ旧来の素の直接 JOIN が残っていないことを確認する。
// =============================================================================

const WHOLESALER_MERCHANTS_DEDUP_BLOCK =
  '-- wholesaler_merchants に customer_code+wholesaler_id の重複行があっても\n' +
  '-- invoice_lines が水増しされないよう、customer_code 単位で最新1件のみに絞り込む\n' +
  '-- registration_at が同一の場合の非決定性を避けるため、id(UUID v7)の降順もタイブレークに含める\n' +
  'JOIN (\n' +
  '  SELECT customer_code, mall_code,\n' +
  '    ROW_NUMBER() OVER (PARTITION BY customer_code ORDER BY registration_at DESC, id DESC) AS rn\n' +
  '  FROM `test-project.test_dataset.wholesaler_merchants`\n' +
  '  WHERE wholesaler_id = 123\n' +
  '    AND deleted_at IS NULL\n' +
  ') wm\n' +
  '  ON wm.customer_code = s.customer_code\n' +
  '  AND wm.rn = 1';

test('buildTransactionSql_: invoice_lines JOIN は wholesaler_merchants の重複行対策サブクエリになっている', () => {
  const sandbox = createSandbox();
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
      exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0,
      feeAmount: 33, paymentAmount: 1067,
    },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };
  const accountInfo = { wholesaler_id: 123, wholesaler_user_id: '22222222-2222-2222-2222-222222222222', fee_rate: 3 };

  const sql = sandbox.buildTransactionSql_(
    '11111111-1111-1111-1111-111111111111',
    'staging_test_0001',
    summaryData,
    {},
    accountInfo,
    {},
    'https://example.test/dummy.csv',
    'test-project',
    'test_dataset'
  );

  assert.ok(sql.includes(WHOLESALER_MERCHANTS_DEDUP_BLOCK), '重複排除サブクエリが含まれること');
  assert.ok(
    sql.includes('AND wm.rn = 1\nJOIN `test-project.test_dataset.store_invoices` si'),
    'サブクエリの直後に store_invoices との JOIN が続くこと'
  );
  assert.ok(
    !sql.includes('JOIN `test-project.test_dataset.wholesaler_merchants` wm'),
    '旧来の素の直接JOINが残っていないこと'
  );
});

test('buildResubmitTransactionSql_: invoice_lines JOIN は wholesaler_merchants の重複行対策サブクエリになっている', () => {
  const sandbox = createSandbox();
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
      exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0,
    },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };
  const accountInfo = {
    wholesaler_id: 123, wholesaler_user_id: '22222222-2222-2222-2222-222222222222',
    fee_rate: 3, tax_rounding_method: 'floor',
  };
  const latestWi = {
    wholesaler_invoice_date: '2026-07-01',
    wholesaler_total_amount: 5000, wholesaler_subtotal_amount: 4500, wholesaler_tax_amount: 500,
    wholesaler_standard_tax_target_amount: 4500, wholesaler_standard_tax_amount: 500,
    wholesaler_reduced_tax_target_amount: 0, wholesaler_reduced_tax_amount: 0,
    wholesaler_non_taxable_amount: 0,
  };
  const oldStoreAmounts = { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };

  const sql = sandbox.buildResubmitTransactionSql_(
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    'staging_test_0001',
    summaryData,
    {},
    null,
    null,
    accountInfo,
    {},
    'https://example.test/dummy.csv',
    'test-project',
    'test_dataset',
    latestWi,
    oldStoreAmounts
  );

  assert.ok(sql.includes(WHOLESALER_MERCHANTS_DEDUP_BLOCK), '重複排除サブクエリが含まれること');
  assert.ok(
    sql.includes('AND wm.rn = 1\nJOIN `test-project.test_dataset.store_invoices` si'),
    'サブクエリの直後に store_invoices との JOIN が続くこと'
  );
  assert.ok(
    !sql.includes('JOIN `test-project.test_dataset.wholesaler_merchants` wm'),
    '旧来の素の直接JOINが残っていないこと'
  );
});

test('buildBulkResubmitTransactionSql_: invoice_lines JOIN は wholesaler_merchants の重複行対策サブクエリになっている', () => {
  const sandbox = createSandbox();
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
      exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0,
    },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };
  const accountInfo = {
    wholesaler_id: 123, wholesaler_user_id: '22222222-2222-2222-2222-222222222222',
    fee_rate: 3, tax_rounding_method: 'floor',
  };
  const latestWi = {
    wholesaler_invoice_date: '2026-07-01',
    wholesaler_total_amount: 5000, wholesaler_subtotal_amount: 4500, wholesaler_tax_amount: 500,
    wholesaler_standard_tax_target_amount: 4500, wholesaler_standard_tax_amount: 500,
    wholesaler_reduced_tax_target_amount: 0, wholesaler_reduced_tax_amount: 0,
    wholesaler_non_taxable_amount: 0,
  };
  const oldStoreAmounts = { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };

  const sql = sandbox.buildBulkResubmitTransactionSql_(
    '11111111-1111-1111-1111-111111111111',
    'staging_test_0001',
    summaryData,
    {},
    {},
    {},
    accountInfo,
    {},
    'https://example.test/dummy.csv',
    'test-project',
    'test_dataset',
    latestWi,
    oldStoreAmounts
  );

  assert.ok(sql.includes(WHOLESALER_MERCHANTS_DEDUP_BLOCK), '重複排除サブクエリが含まれること');
  assert.ok(
    sql.includes('AND wm.rn = 1\nJOIN `test-project.test_dataset.store_invoices` si'),
    'サブクエリの直後に store_invoices との JOIN が続くこと'
  );
  assert.ok(
    !sql.includes('JOIN `test-project.test_dataset.wholesaler_merchants` wm'),
    '旧来の素の直接JOINが残っていないこと'
  );
});

// =============================================================================
// 検証7: fetchInvoiceDetail の catch は Slack通知コンテキストに誤解を招く
//         invoiceUuid キーではなく parentInvoiceId キーを使う
//
// 背景:
//   invoiceId 引数は fetchInvoiceDetailSummary_ 内の SQL
//   （WHERE wi.id = @invoice_id OR wi.wholesaler_invoice_id = @invoice_id）が示す通り、
//   wi.id（内部UUID）・wi.wholesaler_invoice_id（別形式のID）のどちらでもあり得るため、
//   実体がUUIDとは限らない。にもかかわらず Slack通知コンテキストで「invoiceUuid」という
//   キー名を使うと、インシデント対応時に誤解を招く。
//   SLACK_CONTEXT_ID_KEYS_（be_slack.js）に既に含まれる parentInvoiceId
//   （大元の wholesaler_invoices を指すIDという意味）を使うのが正しい。
// =============================================================================

test('fetchInvoiceDetail: catch のSlack通知コンテキストは invoiceUuid ではなく parentInvoiceId を使う（誤解を招くキー名の修正）', () => {
  const sandbox = createSandbox({ parentSummary: { id: PARENT_INVOICE_ID } });
  // fetchInvoiceDetailSummary_ 通過後、後続の fetchStoreInvoicesByParent_ でエラーを発生させ、
  // fetchInvoiceDetail の catch ブロックを通過させる。
  sandbox.fetchStoreInvoicesByParent_ = function () { throw new Error('BQ接続エラー(テスト用)'); };

  let thrown = null;
  try {
    sandbox.fetchInvoiceDetail(PARENT_INVOICE_ID, 'dummy-session-token');
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, '例外が再送出されるはず');
  assert.equal(sandbox.__logErrorCalls.length, 1);
  const ctx = sandbox.__logErrorCalls[0].context;
  assert.equal(ctx.parentInvoiceId, PARENT_INVOICE_ID, 'invoiceId は parentInvoiceId キーで渡されること');
  assert.equal(ctx.invoiceUuid, undefined, '誤解を招く invoiceUuid キーは使われないこと（実体はUUIDとは限らないため）');
});

// =============================================================================
// 検証8〜11: 再請求時に旧レコードの否認理由（store_disputed_reason）が
//            新規 INSERT される store_invoices レコードに引き継がれない不具合の修正
//
// 背景:
//   再請求時（個別・CSV一括とも）に新規 INSERT される store_invoices の列リストに
//   store_disputed_reason が含まれていなかったため、否認理由が常に NULL になり、
//   詳細画面の確認中・承認済一覧で否認理由が表示されなくなっていた不具合があった。
//   本テストは、旧レコードの store_disputed_reason が正しく引き継がれ、
//   生成される SQL の INSERT 列リスト・VALUES に含まれることを検証する。
// =============================================================================

test('buildResubmitTransactionSql_: 否認理由(storeDisputedReason)がINSERT列とVALUESに反映される', () => {
  const sandbox = createSandbox();
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
      exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0,
    },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };
  const accountInfo = {
    wholesaler_id: 123, wholesaler_user_id: '22222222-2222-2222-2222-222222222222',
    fee_rate: 3, tax_rounding_method: 'floor',
  };
  const latestWi = {
    wholesaler_invoice_date: '2026-07-01',
    wholesaler_total_amount: 5000, wholesaler_subtotal_amount: 4500, wholesaler_tax_amount: 500,
    wholesaler_standard_tax_target_amount: 4500, wholesaler_standard_tax_amount: 500,
    wholesaler_reduced_tax_target_amount: 0, wholesaler_reduced_tax_amount: 0,
    wholesaler_non_taxable_amount: 0,
  };
  const oldStoreAmounts = { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };

  const sql = sandbox.buildResubmitTransactionSql_(
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    'staging_test_0001',
    summaryData,
    {},
    null,
    '数量に誤りがあったため否認します',
    accountInfo,
    {},
    'https://example.test/dummy.csv',
    'test-project',
    'test_dataset',
    latestWi,
    oldStoreAmounts
  );

  assert.ok(
    sql.includes('   non_taxable_amount, wholesaler_remark, wholesaler_handover, store_disputed_reason,'),
    'INSERT列リストにstore_disputed_reasonが追加されていること'
  );
  assert.ok(sql.includes("NULL, NULL, '\u6570量に\u8aa4\u308a\u304c\u3042\u3063\u305f\u305f\u3081\u5426\u8a8d\u3057\u307e\u3059', 'PENDING_REVIEW', TRUE,"), 'VALUESに否認理由の値が正しい位置（wholesaler_remark・wholesaler_handoverの直後）に含まれること');
});

test('buildResubmitTransactionSql_: storeDisputedReasonがnullの場合はVALUESでNULLになる', () => {
  const sandbox = createSandbox();
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
      exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0,
    },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };
  const accountInfo = {
    wholesaler_id: 123, wholesaler_user_id: '22222222-2222-2222-2222-222222222222',
    fee_rate: 3, tax_rounding_method: 'floor',
  };
  const latestWi = {
    wholesaler_invoice_date: '2026-07-01',
    wholesaler_total_amount: 5000, wholesaler_subtotal_amount: 4500, wholesaler_tax_amount: 500,
    wholesaler_standard_tax_target_amount: 4500, wholesaler_standard_tax_amount: 500,
    wholesaler_reduced_tax_target_amount: 0, wholesaler_reduced_tax_amount: 0,
    wholesaler_non_taxable_amount: 0,
  };
  const oldStoreAmounts = { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };

  const sql = sandbox.buildResubmitTransactionSql_(
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    'staging_test_0001',
    summaryData,
    {},
    null,
    null,
    accountInfo,
    {},
    'https://example.test/dummy.csv',
    'test-project',
    'test_dataset',
    latestWi,
    oldStoreAmounts
  );

  assert.ok(/NULL, NULL, NULL, 'PENDING_REVIEW', TRUE,/.test(sql), '否認理由未指定時はNULLになること（wholesaler_remark・wholesaler_handover・store_disputed_reasonの3連続）');
});

test('buildBulkResubmitTransactionSql_: 加盟店ごとの否認理由(disputedReasons)がINSERT列とVALUESに反映される', () => {
  const sandbox = createSandbox();
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 3300, subtotalAmount: 3000, taxAmount: 300,
      exTax10: 3000, tax10: 300, exTax8: 0, tax8: 0,
    },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
      { customerCode: 'CUST002', totalAmount: 2200, subtotalAmount: 2000, taxAmount: 200, exTax10: 2000, tax10: 200, exTax8: 0, tax8: 0 },
    ],
  };
  const accountInfo = {
    wholesaler_id: 123, wholesaler_user_id: '22222222-2222-2222-2222-222222222222',
    fee_rate: 3, tax_rounding_method: 'floor',
  };
  const latestWi = {
    wholesaler_invoice_date: '2026-07-01',
    wholesaler_total_amount: 5000, wholesaler_subtotal_amount: 4500, wholesaler_tax_amount: 500,
    wholesaler_standard_tax_target_amount: 4500, wholesaler_standard_tax_amount: 500,
    wholesaler_reduced_tax_target_amount: 0, wholesaler_reduced_tax_amount: 0,
    wholesaler_non_taxable_amount: 0,
  };
  const oldStoreAmounts = { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };
  const disputedReasons = { CUST001: '数量に誤りがあったため否認します' }; // CUST002は否認理由なし（差し戻し想定）

  const sql = sandbox.buildBulkResubmitTransactionSql_(
    '11111111-1111-1111-1111-111111111111',
    'staging_test_0001',
    summaryData,
    {},
    {},
    disputedReasons,
    accountInfo,
    {},
    'https://example.test/dummy.csv',
    'test-project',
    'test_dataset',
    latestWi,
    oldStoreAmounts
  );

  assert.ok(
    sql.includes('   non_taxable_amount, wholesaler_remark, wholesaler_handover, store_disputed_reason,'),
    'INSERT列リストにstore_disputed_reasonが追加されていること'
  );
  assert.ok(sql.includes("'\u6570\u91cf\u306b\u8aa4\u308a\u304c\u3042\u3063\u305f\u305f\u3081\u5426\u8a8d\u3057\u307e\u3059'"), 'CUST001の否認理由がVALUESに含まれること');
});

test('resubmitInvoiceData: 旧レコードの否認理由(store_disputed_reason)が対象storeInvoiceId経由で新規INSERTのSQLに引き継がれる', () => {
  const TARGET_STORE_INVOICE_ID = '33333333-3333-3333-3333-333333333333';
  const storeRows = [
    makeStoreRow('CUST001', 'MALL-C001', TARGET_STORE_INVOICE_ID, {
      store_disputed_reason: '数量に誤りがあったため否認します',
      backoffice_review_status: 'MERCHANT_CONFIRMATION_REQUESTED',
      invoice_status: 'DISPUTED',
    }),
  ];
  const sandbox = createSandbox({ storeRows: storeRows });

  const csvText = buildCsvText(['CUST001,2026/07/01,テスト商品,1,1000,10,1000,100,']);
  const summaryData = {
    wholesalerTotal: { totalAmount: 1100 },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };

  const result = sandbox.resubmitInvoiceData(
    'dummy-raw-csv-base64',
    csvText,
    'test.csv',
    summaryData,
    {},
    PARENT_INVOICE_ID,
    TARGET_STORE_INVOICE_ID,
    '加盟店と合意済みです',
    'dummy-session-token'
  );

  assert.equal(result.status, 'success');
  assert.equal(sandbox.__runTransactionSqlCalls.length, 1);
  const sql = sandbox.__runTransactionSqlCalls[0].sql;
  assert.ok(sql.includes("'\u6570\u91cf\u306b\u8aa4\u308a\u304c\u3042\u3063\u305f\u305f\u3081\u5426\u8a8d\u3057\u307e\u3059'"), '対象storeInvoiceIdの否認理由がSQLのVALUESに含まれること');
  assert.ok(
    sql.includes('   non_taxable_amount, wholesaler_remark, wholesaler_handover, store_disputed_reason,'),
    'INSERT列リストにstore_disputed_reasonが追加されていること'
  );
});

// =============================================================================
// 検証12〜14: cancelWithdrawRequest（取り下げ依頼の取り消し）
//
// 背景:
//   cancelWithdrawRequest は (1) 事前バリデーション（対象行・最新WI取得）、
//   (2) 異議申立期間（OBJECTION_PERIOD）の期限判定、(3) BEGIN TRANSACTION +
//   @@row_count = 0 検知（並行更新・事前バリデーション後の状態変化を検知）の
//   3つの分岐を組み合わせた構造になっている。これらはいずれも期限切れ時のエラー
//   メッセージや並行更新時の挙動という仕様上重要な分岐であり、これまでユニットテストが
//   一切存在しなかった（test/ 配下に cancelWithdrawRequest を直接呼ぶテストは未整備）。
//   本テストは以下の3パターンを検証する:
//     (a) 異議申立期間内での成功（MERCHANT_CONFIRMATION_REQUESTED に戻すUPDATEが実行される）
//     (b) 異議申立期間終了済みの場合、SQLを実行せず error_() を返す
//     (c) UPDATE が @@row_count = 0（並行更新等）で失敗した場合、例外を投げず
//         業務エラー（error_()）として返す
// =============================================================================

const CANCEL_WITHDRAW_STORE_INVOICE_ID = '33333333-3333-3333-3333-333333333333';

test('cancelWithdrawRequest: 異議申立期間内であれば MERCHANT_CONFIRMATION_REQUESTED に戻して成功する', () => {
  const sandbox = createSandbox({
    cancelWithdrawStoreRow: {
      id: CANCEL_WITHDRAW_STORE_INVOICE_ID,
      invoice_status: 'DISPUTED',
      backoffice_review_status: 'WITHDRAW_REQUESTED',
    },
    // Utilities.formatDate スタブは常に '2026-07-07' を返すため、それより後の日付なら「期間内」。
    objectionPeriodRow: { end_at: '2026-07-31' },
  });

  const result = sandbox.cancelWithdrawRequest(CANCEL_WITHDRAW_STORE_INVOICE_ID, PARENT_INVOICE_ID, 'dummy-session-token');

  assert.equal(result.status, 'success');
  assert.equal(result.data.store_invoice_id, CANCEL_WITHDRAW_STORE_INVOICE_ID);
  assert.equal(sandbox.__runTransactionSqlCalls.length, 1, 'UPDATEが1回実行されること');

  const sql = sandbox.__runTransactionSqlCalls[0].sql;
  assert.ok(sql.includes("SET backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED'"), 'MERCHANT_CONFIRMATION_REQUESTEDに戻すUPDATEであること（PENDING_REVIEWではない）');
  assert.ok(sql.includes("WHERE id = '" + CANCEL_WITHDRAW_STORE_INVOICE_ID + "'"), '対象の store_invoice_id で絞り込むこと');
  assert.ok(sql.includes("AND backoffice_review_status = 'WITHDRAW_REQUESTED'"), '元のステータスがWITHDRAW_REQUESTEDであることを条件に含むこと');
  assert.ok(sql.includes("AND invoice_status = 'DISPUTED'"), 'invoice_status=DISPUTEDを条件に含むこと');
  assert.ok(sql.includes('BEGIN TRANSACTION;') && sql.includes('COMMIT;'), 'BEGIN TRANSACTION〜COMMITで包んだSQLであること');
  assert.ok(sql.includes('IF @@row_count = 0 THEN'), '@@row_count検証を含むこと');
});

test('cancelWithdrawRequest: 異議申立期間が終了している場合はSQLを実行せずerror_を返す', () => {
  const sandbox = createSandbox({
    cancelWithdrawStoreRow: {
      id: CANCEL_WITHDRAW_STORE_INVOICE_ID,
      invoice_status: 'DISPUTED',
      backoffice_review_status: 'WITHDRAW_REQUESTED',
    },
    // Utilities.formatDate スタブは常に '2026-07-07' を返すため、それより前の日付なら「期間終了済み」。
    objectionPeriodRow: { end_at: '2026-07-01' },
  });

  const result = sandbox.cancelWithdrawRequest(CANCEL_WITHDRAW_STORE_INVOICE_ID, PARENT_INVOICE_ID, 'dummy-session-token');

  assert.equal(result.status, 'error');
  assert.equal(result.message, '異議申立期間が終了しているため、取り下げ依頼の取り消しはできません。');
  assert.equal(sandbox.__runTransactionSqlCalls.length, 0, '期間切れの場合はUPDATE自体が実行されないこと');
  assert.equal(sandbox.__logErrorCalls.length, 0, '業務エラーはSlack通知（logError_）対象外であること');
});

test('cancelWithdrawRequest: UPDATEが@@row_count=0（並行更新等）で失敗した場合は例外を投げず業務エラーを返す', () => {
  const sandbox = createSandbox({
    cancelWithdrawStoreRow: {
      id: CANCEL_WITHDRAW_STORE_INVOICE_ID,
      invoice_status: 'DISPUTED',
      backoffice_review_status: 'WITHDRAW_REQUESTED',
    },
    // 異議申立期間の制約なし（business_calendarに該当行なし）を想定し、SQL実行まで進めるようにする。
    objectionPeriodRow: null,
  });

  // runTransactionSql_ を上書きし、BQが RAISE USING MESSAGE = '他の操作と競合した...' で
  // 失敗したときの実際の挙動（runTransactionSql_ が例外をthrowする）を再現する。
  const runTransactionSqlCalls = [];
  sandbox.runTransactionSql_ = function (projectId, sql) {
    runTransactionSqlCalls.push({ projectId: projectId, sql: sql });
    throw new Error('[BQ] トランザクションエラー: 他の操作と競合したため更新できませんでした。ページを再読み込みして再度お試しください。');
  };

  let thrown = null;
  let result = null;
  try {
    result = sandbox.cancelWithdrawRequest(CANCEL_WITHDRAW_STORE_INVOICE_ID, PARENT_INVOICE_ID, 'dummy-session-token');
  } catch (e) {
    thrown = e;
  }

  assert.equal(thrown, null, '@@row_count=0のRAISEは業務エラーに変換され、例外としては再スローされないこと');
  assert.ok(result, 'error_ の戻り値が得られること');
  assert.equal(result.status, 'error');
  assert.equal(result.message, '対象の請求が見つからないか、既にステータスが変更されています。ページを再読み込みしてください。');
  assert.equal(runTransactionSqlCalls.length, 1, 'UPDATE（失敗するもの）は1回は実行されていること');
  assert.equal(sandbox.__logErrorCalls.length, 0, '業務エラーとして処理されるためSlack通知（logError_）対象外であること');
});

// =============================================================================
// 検証15〜16: withdrawStoreInvoice（請求取り下げ依頼）
//
// 背景:
//   withdrawStoreInvoice は cancelWithdrawRequest と異なり事前バリデーション
//   （DB問い合わせによる対象行の存在確認）を行わず、UUID形式チェックの後、
//   直接 BEGIN TRANSACTION 〜 COMMIT + @@row_count = 0 検知の1文UPDATEを実行する
//   構造になっている。@@row_count = 0（並行更新や画面表示後の状態変化で対象行が
//   0件だった場合）を検知しなければ、対象0件でもBQ上はエラーにならず成功扱いとなり、
//   画面上は成功トーストが出るのに実際は何も更新されない不整合が起こり得るため、
//   この検知とerror_()への変換は仕様上重要な振る舞いである。これまでユニットテストが
//   一切存在しなかった（test/ 配下に withdrawStoreInvoice を直接呼ぶテストは未整備）。
//   本テストは以下の2パターンを検証する:
//     (a) 正常系: WITHDRAW_REQUESTED への更新SQLが正しく組み立てられ実行される
//     (b) UPDATE が @@row_count = 0（並行更新等）で失敗した場合、例外を投げず
//         業務エラー（error_()）として返す
// =============================================================================

const WITHDRAW_STORE_INVOICE_ID = '44444444-4444-4444-4444-444444444444';

test('withdrawStoreInvoice: 正常系でWITHDRAW_REQUESTEDへの更新SQLが実行され成功する', () => {
  const sandbox = createSandbox();

  const result = sandbox.withdrawStoreInvoice(WITHDRAW_STORE_INVOICE_ID, PARENT_INVOICE_ID, 'dummy-session-token');

  assert.equal(result.status, 'success');
  assert.equal(result.data.store_invoice_id, WITHDRAW_STORE_INVOICE_ID);
  assert.equal(sandbox.__runTransactionSqlCalls.length, 1, 'UPDATEが1回実行されること');

  const sql = sandbox.__runTransactionSqlCalls[0].sql;
  assert.ok(sql.includes("SET backoffice_review_status = 'WITHDRAW_REQUESTED'"), 'WITHDRAW_REQUESTEDに更新するUPDATEであること');
  assert.ok(sql.includes("WHERE id = '" + WITHDRAW_STORE_INVOICE_ID + "'"), '対象の store_invoice_id で絞り込むこと');
  assert.ok(sql.includes("AND invoice_status = 'DISPUTED'"), 'invoice_status=DISPUTEDを条件に含むこと');
  assert.ok(
    sql.includes("AND backoffice_review_status IN ('RETURNED', 'MERCHANT_CONFIRMATION_REQUESTED')"),
    'FEのボタン表示条件と揃えたbackoffice_review_status制限を含むこと（API直叩き対策）'
  );
  assert.ok(sql.includes('BEGIN TRANSACTION;') && sql.includes('COMMIT;'), 'BEGIN TRANSACTION〜COMMITで包んだSQLであること');
  assert.ok(sql.includes('IF @@row_count = 0 THEN'), '@@row_count検証を含むこと');
});

test('withdrawStoreInvoice: UPDATEが@@row_count=0（並行更新等）で失敗した場合は例外を投げず業務エラーを返す', () => {
  const sandbox = createSandbox();

  // runTransactionSql_ を上書きし、BQが RAISE USING MESSAGE = '他の操作と競合した...' で
  // 失敗したときの実際の挙動（runTransactionSql_ が例外をthrowする）を再現する。
  const runTransactionSqlCalls = [];
  sandbox.runTransactionSql_ = function (projectId, sql) {
    runTransactionSqlCalls.push({ projectId: projectId, sql: sql });
    throw new Error('[BQ] トランザクションエラー: 他の操作と競合したため更新できませんでした。ページを再読み込みして再度お試しください。');
  };

  let thrown = null;
  let result = null;
  try {
    result = sandbox.withdrawStoreInvoice(WITHDRAW_STORE_INVOICE_ID, PARENT_INVOICE_ID, 'dummy-session-token');
  } catch (e) {
    thrown = e;
  }

  assert.equal(thrown, null, '@@row_count=0のRAISEは業務エラーに変換され、例外としては再スローされないこと');
  assert.ok(result, 'error_ の戻り値が得られること');
  assert.equal(result.status, 'error');
  assert.equal(result.message, '対象の請求が見つからないか、既にステータスが変更されています。ページを再読み込みしてください。');
  assert.equal(runTransactionSqlCalls.length, 1, 'UPDATE（失敗するもの）は1回は実行されていること');
  assert.equal(sandbox.__logErrorCalls.length, 0, '業務エラーとして処理されるためSlack通知（logError_）対象外であること');
});

test('bulkResubmitInvoiceData: 旧レコードの否認理由(store_disputed_reason)がcustomerCode単位で新規INSERTのSQLに引き継がれる', () => {
  const storeRows = [
    makeStoreRow('CUST001', 'MALL-C001', 'SI-C001-OLD', {
      store_disputed_reason: '数量に誤りがあったため否認します',
      backoffice_review_status: 'MERCHANT_CONFIRMATION_REQUESTED',
      invoice_status: 'DISPUTED',
    }),
    makeStoreRow('CUST003', 'MALL-C003', 'SI-C003-OLD', {
      store_disputed_reason: '',
      backoffice_review_status: 'RETURNED',
    }),
  ];
  const actionRequiredRows = [
    { mall_code: 'MALL-C001', invoice_status: 'DISPUTED' },
    { mall_code: 'MALL-C003', invoice_status: '' },
  ];
  const sandbox = createSandbox({ storeRows: storeRows, actionRequiredRows: actionRequiredRows });

  const csvText = buildCsvText([
    'CUST001,2026/07/01,テスト商品,1,1000,10,1000,100,',
    'CUST003,2026/07/01,テスト商品,1,2000,10,2000,200,',
  ]);
  const summaryData = {
    wholesalerTotal: { totalAmount: 3300 },
    merchantTotals: [
      { customerCode: 'CUST001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100, exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
      { customerCode: 'CUST003', totalAmount: 2200, subtotalAmount: 2000, taxAmount: 200, exTax10: 2000, tax10: 200, exTax8: 0, tax8: 0 },
    ],
  };

  const result = sandbox.bulkResubmitInvoiceData(
    'dummy-raw-csv-base64',
    csvText,
    'test.csv',
    summaryData,
    {},
    PARENT_INVOICE_ID,
    { CUST001: '加盟店と合意済みです' },
    'dummy-session-token'
  );

  assert.equal(result.status, 'success');
  assert.equal(sandbox.__runTransactionSqlCalls.length, 1);
  const sql = sandbox.__runTransactionSqlCalls[0].sql;
  assert.ok(sql.includes("'\u6570\u91cf\u306b\u8aa4\u308a\u304c\u3042\u3063\u305f\u305f\u3081\u5426\u8a8d\u3057\u307e\u3059'"), 'CUST001の否認理由がSQLのVALUESに含まれること');
  assert.ok(
    sql.includes('   non_taxable_amount, wholesaler_remark, wholesaler_handover, store_disputed_reason,'),
    'INSERT列リストにstore_disputed_reasonが追加されていること'
  );
});

