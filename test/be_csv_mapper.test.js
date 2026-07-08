// =============================================================================
// test/be_csv_mapper.test.js
//
// buildInvoiceLinesSelectSql_（カスタムマッピングCSV形式向け invoice_lines
// INSERT...SELECT 生成関数）における伝票番号(slip_number)・商品コード(item_code)
// パススルー対応のユニットテスト。
//
// 背景:
//   卸ごとの csv_format_rules.columns に system_column: 'slip_number' /
//   'item_code' を定義しても、ALLOWED_SYSTEM_COLUMNS ホワイトリストに
//   含まれていなかったため、CSVに列があっても invoice_lines への INSERT が
//   サイレントにスキップされていた（Logger.log で警告のみ）。
//   本修正では ALLOWED_SYSTEM_COLUMNS に両カラムを追加し、CSVに列がある
//   場合は invoice_lines.slip_number / invoice_lines.item_code に登録され、
//   CSVに列が無い場合は（従来通り）NULLのまま登録されることを確認する。
//
//   新規アップロード・個別再請求・一括再請求の3フローはいずれも
//   buildMappedTransactionSql_ / buildMappedResubmitTransactionSql_ /
//   buildMappedBulkResubmitTransactionSql_ を経由し、最終的に本ファイルが
//   テストする buildInvoiceLinesSelectSql_ を共通で呼び出しているため、
//   この1関数のテストで3フロー全てのカバレッジを兼ねる。
//
// src/be_csv_mapper.js を「未改変のまま」vm サンドボックスへ読み込んで検証する
// （test/be_invoice.test.js と同じ vm.createContext + vm.runInContext 方式。
//  対象ソースへ module.exports 等を追加することは禁止のため require() は使わない）。
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BE_CSV_MAPPER_PATH = path.join(__dirname, '..', 'src', 'be_csv_mapper.js');
const BE_CSV_MAPPER_SRC = fs.readFileSync(BE_CSV_MAPPER_PATH, 'utf8');

/**
 * GAS のグローバル API（Logger）をスタブした vm サンドボックスを作成し、
 * src/be_csv_mapper.js を未改変のまま読み込んで返す。
 * escSql_ / parseCsvLineMapper_ / sanitizeComment_ / padRight_ / isNewFormatRules_ は
 * すべて be_csv_mapper.js 自身に定義されているため、追加のスタブは不要。
 *
 * @returns {vm.Context}
 */
function createSandbox() {
  const sandbox = {
    console: console,
    Logger: { log: function () {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(BE_CSV_MAPPER_SRC, sandbox, { filename: 'be_csv_mapper.js' });
  return sandbox;
}

/**
 * REQUIRED_SYSTEM_COLUMNS（customer_code / transaction_date / item_name /
 * quantity / unit_price / amount_ex_tax / tax_rate）を満たす最小限の
 * columns 配列を組み立てる。
 *
 * @param {Array<Object>} [extra] - 追加で連結する列定義
 * @returns {Array<Object>}
 */
function buildBaseColumns(extra) {
  const base = [
    { index: 0, csv_header: '顧客コード',   system_column: 'customer_code',    type: 'string',  required: true },
    { index: 1, csv_header: '伝票日付',     system_column: 'transaction_date', type: 'date',    format: 'YYYY-MM-DD', required: true },
    { index: 2, csv_header: '品目',         system_column: 'item_name',       type: 'string',  required: true },
    { index: 3, csv_header: '数量',         system_column: 'quantity',        type: 'decimal', required: true },
    { index: 4, csv_header: '単価',         system_column: 'unit_price',      type: 'decimal', required: true },
    { index: 5, csv_header: '金額（税抜）', system_column: 'amount_ex_tax',   type: 'decimal', required: true },
    { index: 6, csv_header: '税率',         system_column: 'tax_rate',        type: 'integer', required: true },
  ];
  return base.concat(extra || []);
}

const STAGING_REF   = '`test-project.test_dataset.staging_invoice_lines_xxxx`';
const INVOICE_UUID  = '11111111-1111-1111-1111-111111111111';
const WHOLESALER_ID = 123;
const MERCHANTS_REF = '`test-project.test_dataset.wholesaler_merchants`';
const STORE_REF     = '`test-project.test_dataset.store_invoices`';

/**
 * buildInvoiceLinesSelectSql_ をテスト用デフォルト引数で呼び出す。
 *
 * @param {Object} sandbox
 * @param {Array<Object>} columns
 * @returns {{ insertColumns: string[], selectSql: string, validateCases: Array }}
 */
function callBuild(sandbox, columns) {
  return sandbox.buildInvoiceLinesSelectSql_(
    { has_header: true, columns: columns },
    STAGING_REF,
    INVOICE_UUID,
    WHOLESALER_ID,
    MERCHANTS_REF,
    STORE_REF,
    {},
    'floor'
  );
}

// =============================================================================
// 検証1: 伝票番号(slip_number)・商品コード(item_code)がCSVに定義されている場合、
//        invoice_lines への INSERT カラム・SELECT式に含まれる
// =============================================================================

test('buildInvoiceLinesSelectSql_: slip_number/item_code が columns に定義されている場合はINSERT対象に含まれる', () => {
  const sandbox = createSandbox();
  const columns = buildBaseColumns([
    { index: 7, csv_header: '伝票番号',   system_column: 'slip_number', type: 'string', required: false },
    { index: 8, csv_header: '商品コード', system_column: 'item_code',   type: 'string', required: false },
  ]);

  const result = callBuild(sandbox, columns);

  assert.ok(result.insertColumns.includes('slip_number'), 'insertColumns に slip_number が含まれること');
  assert.ok(result.insertColumns.includes('item_code'), 'insertColumns に item_code が含まれること');
  assert.match(result.selectSql, /s\.string_field_7\s+AS slip_number,/);
  assert.match(result.selectSql, /s\.string_field_8\s+AS item_code,/);
});

// =============================================================================
// 検証2: 伝票番号・商品コードがCSVに定義されていない場合は、従来通り
//        insertColumns/selectSql に含まれない（= BQ側でNULLのまま登録される）
// =============================================================================

test('buildInvoiceLinesSelectSql_: slip_number/item_code が columns に無い場合はINSERT対象に含まれない（NULL登録）', () => {
  const sandbox = createSandbox();
  const columns = buildBaseColumns(); // slip_number/item_code を含めない

  const result = callBuild(sandbox, columns);

  assert.ok(!result.insertColumns.includes('slip_number'), 'insertColumns に slip_number が含まれないこと');
  assert.ok(!result.insertColumns.includes('item_code'), 'insertColumns に item_code が含まれないこと');
  assert.doesNotMatch(result.selectSql, /AS slip_number/);
  assert.doesNotMatch(result.selectSql, /AS item_code/);
});

// =============================================================================
// 検証3: ホワイトリストに無い未知の system_column は従来通りサイレントに
//        スキップされる（今回の修正がホワイトリスト機構自体を壊していないこと）
// =============================================================================

test('buildInvoiceLinesSelectSql_: ホワイトリスト外のsystem_column（例: merchant_name）は従来通りスキップされる', () => {
  const sandbox = createSandbox();
  const columns = buildBaseColumns([
    { index: 7, csv_header: '得意先名', system_column: 'merchant_name', type: 'string', required: false },
  ]);

  const result = callBuild(sandbox, columns);

  assert.ok(!result.insertColumns.includes('merchant_name'), 'ホワイトリスト外の列はinsertColumnsに含まれないこと');
  assert.doesNotMatch(result.selectSql, /AS merchant_name/);
});

// =============================================================================
// 検証4: slip_number/item_code は任意項目のため、required:false の場合
//        「必須項目です」という空文字バリデーションは追加されない
//        （制御文字・改行チェックのみ、既存の文字列カラムと同様に追加される）
// =============================================================================

test('buildInvoiceLinesSelectSql_: slip_number/item_code はrequired:falseのため空文字必須チェックは追加されない', () => {
  const sandbox = createSandbox();
  const baseColumns = buildBaseColumns();
  const withNewColumns = buildBaseColumns([
    { index: 7, csv_header: '伝票番号',   system_column: 'slip_number', type: 'string', required: false },
    { index: 8, csv_header: '商品コード', system_column: 'item_code',   type: 'string', required: false },
  ]);

  const baseResult = callBuild(sandbox, baseColumns);
  const newResult  = callBuild(sandbox, withNewColumns);

  // 制御文字・改行チェック（必須有無に関わらず全stringカラムに付与される）が
  // slip_number/item_code の2件分だけ増えていることを確認する。
  assert.equal(newResult.validateCases.length, baseResult.validateCases.length + 2);

  // 「必須項目です」という required 由来のメッセージは追加されていないことを確認する。
  const newMessages = newResult.validateCases.map(function (c) { return c.message; });
  const hasRequiredMsgForNewCols = newMessages.some(function (m) {
    return (m.indexOf('伝票番号') !== -1 || m.indexOf('商品コード') !== -1) && m.indexOf('必須項目') !== -1;
  });
  assert.equal(hasRequiredMsgForNewCols, false, '任意項目のため必須チェックメッセージは追加されないこと');
});

// =============================================================================
// 検証5: wholesaler_merchants に customer_code+wholesaler_id の重複行が存在していても
//        invoice_lines が水増し登録されないこと（MYP-4204 バグ対応part10）。
//
// 背景:
//   新規アップロード・個別再請求・一括再請求の3フローが共通で使用する
//   buildInvoiceLinesSelectSql_ の invoice_lines INSERT...SELECT は、
//   wholesaler_merchants を customer_code + wholesaler_id + deleted_at IS NULL の
//   条件で直接 JOIN していたため、同一 customer_code+wholesaler_id の有効行が
//   誤って複数登録されていた場合に JOIN の fan-out で invoice_lines が重複登録
//   される恐れがあった。
//
//   本修正では wholesaler_merchants を直接 JOIN せず、customer_code 単位で
//   registration_at が最新の1件のみに絞り込むサブクエリ
//   （ROW_NUMBER() OVER (PARTITION BY customer_code ORDER BY registration_at DESC) AS rn /
//    rn = 1）を介して JOIN するように変更した。
// =============================================================================

test('buildInvoiceLinesSelectSql_: invoice_lines JOIN は wholesaler_merchants の重複行対策サブクエリになっている', () => {
  const sandbox = createSandbox();
  const columns = buildBaseColumns();

  const result = callBuild(sandbox, columns);

  const dedupBlock =
    '-- wholesaler_merchants に customer_code+wholesaler_id の重複行があっても\n' +
    '-- invoice_lines が水増しされないよう、customer_code 単位で最新1件のみに絞り込む\n' +
    '-- registration_at が同一の場合の非決定性を避けるため、id(UUID v7)の降順もタイブレークに含める\n' +
    'JOIN (\n' +
    '  SELECT customer_code, mall_code,\n' +
    '    ROW_NUMBER() OVER (PARTITION BY customer_code ORDER BY registration_at DESC, id DESC) AS rn\n' +
    '  FROM ' + MERCHANTS_REF + '\n' +
    '  WHERE wholesaler_id = ' + WHOLESALER_ID + '\n' +
    '    AND deleted_at IS NULL\n' +
    ') wm\n' +
    '  ON wm.customer_code = s.string_field_0\n' +
    '  AND wm.rn = 1';

  assert.ok(result.selectSql.includes(dedupBlock), '重複排除サブクエリが含まれること');
  assert.ok(
    !result.selectSql.includes('JOIN ' + MERCHANTS_REF + ' wm'),
    '旧来の素の直接JOINが残っていないこと'
  );
});

