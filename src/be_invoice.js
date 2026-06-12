// =============================================================================
// be_invoice.js
//
// 請求データ関連の公開関数（フロントから google.script.run で呼ばれる）を管理する。
//
// 公開関数:
//   sendInvoiceData(rawCsvBase64, utf8CsvBase64, summaryData, remarks)
//   fetchInvoices()            ← サーバー側で wholesaler_id を確定（引数不要）
//   fetchInvoiceDetail(invoiceId)
//   fetchScheduleData()        ← business_calendar からスケジュール取得
//
// 依存:
//   be_config.js        … getConfig_()
//   be_utils.js         … success_(), getOrCreateSubFolder_(), formatTimestamp_(), formatYearMonth_()
//   be_csv_mapper.js    … isNewFormatRules_(), validateCsvHeaderByRules_(), buildMappedTransactionSql_()
//   db_bq_connection.js … loadCsvToBq_(), waitForLoadJob_(), runTransactionSql_(), dropStagingTable_()
//   db_bq_query.js      … fetchInvoicesByWholesaler_(), fetchInvoiceDetail_()

// =============================================================================
// 請求登録
// =============================================================================

/**
 * CSV の1行をフィールド配列にパースする（RFC 4180 準拠、状態機械ベース）。
 * デフォルト卸のヘッダー行検証にのみ使用する。
 *
 * @param {string} line - 改行を含まない1行
 * @returns {string[]}
 */
function parseCsvLine_(line) {
  const result = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      if (i > 0 && line[i - 1] === ',') result.push('');
      break;
    }
    if (line[i] === '"') {
      let val = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { val += line[i++]; }
      }
      result.push(val.trim());
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { result.push(line.slice(i).trim()); break; }
      result.push(line.slice(i, end).trim());
      i = end + 1;
    }
  }
  return result;
}

/**
 * CSV のヘッダー行のみを検証する（列数・列名チェック）。
 * デフォルト卸（csv_format_rules が null）の場合に使用する。
 *
 * @param {string}   csvText  - CSV テキスト（UTF-8）
 * @param {string[]} expected - 期待するヘッダー列名の配列（順序込み）
 * @throws {Error} ヘッダー不正時
 */
function validateCsvHeader_(csvText, expected) {
  const firstNewline = csvText.indexOf('\n');
  const headerLine   = firstNewline === -1 ? csvText : csvText.slice(0, firstNewline);
  const cols         = parseCsvLine_(headerLine.replace(/^\uFEFF/, '').replace(/\r$/, ''));
  if (cols.length !== expected.length) {
    logError_('Invoice', 'validateCsvHeader_: format=default, columns=' + cols.length + ' (期待値: ' + expected.length + ')');
    throw new Error(
      'CSVヘッダーの列数が不正です（' + cols.length + '列 / 期待値: ' + expected.length + '列）'
    );
  }
  expected.forEach((name, idx) => {
    if (cols[idx] !== name) {
      logError_('Invoice', 'validateCsvHeader_: ' + (idx + 1) + '列目不正 期待値="' + name + '" 実際="' + cols[idx] + '"');
      throw new Error(
        'CSVヘッダー ' + (idx + 1) + '列目が不正: 期待値="' + name + '" 実際="' + cols[idx] + '"'
      );
    }
  });
  logInfo_('Invoice', 'validateCsvHeader_: format=default, columns=' + cols.length + ', OK');
}

/**
 * デフォルト9列フォーマット用の期待ヘッダー列名配列を返す。
 * db_bq_connection.js の STAGING_SCHEMA_ と完全一致させること。
 *
 * @returns {string[]}
 */
function getExpectedHeaders_() {
  return [
    '顧客コード', '日付', '品目', '数量', '単価',
    '税率区分(%)', '請求金額（税抜）', '消費税', '備考',
  ];
}

/**
 * ダブルクォートで囲まれたフィールド内の改行をスペースに置換する前処理。
 * RFC 4180 ではクォート内改行はフィールド値の一部だが、後段の split('\n') で
 * 行が壊れるため、事前にスペースへ正規化する。
 *
 * @param {string} csvText - CSV テキスト全体
 * @returns {string} クォート内改行をスペースに置換済みのテキスト
 */
function stripQuotedNewlines_(csvText) {
  var result = '', inQuote = false;
  for (var i = 0; i < csvText.length; i++) {
    var ch = csvText[i];
    if (ch === '"') { inQuote = !inQuote; result += ch; }
    else if (inQuote && (ch === '\n' || ch === '\r')) { result += ' '; }
    else { result += ch; }
  }
  return result;
}

/**
 * CSV テキストから加盟店毎の期待税額を計算し、summaryData.merchantTotals の
 * tax10/tax8 が計算値から ±1円以内であることを検証する。
 * フロントの改ざんを防ぐためのサーバーサイド防御。
 *
 * @param {string} csvText - UTF-8 CSV テキスト
 * @param {Object} summaryData - { merchantTotals: [...] }
 * @param {Object|null} csvFormatRules - accountInfo.csv_format_rules
 * @param {string} roundingMethod - 'floor' | 'ceil' | 'round'
 * @throws {Error} ±1円を超える調整がある場合
 */
function validateTaxAdjustment_(csvText, summaryData, csvFormatRules, roundingMethod) {
  const roundTax = (function () {
    if (roundingMethod === 'ceil') return Math.ceil;
    if (roundingMethod === 'round') return Math.round;
    return Math.floor;
  })();

  const safeCsvText = stripQuotedNewlines_(csvText);
  const lines = safeCsvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return;

  // フィールドのインデックスを特定
  let ccIdx, amtIdx, rateIdx, taxIdx;
  if (isNewFormatRules_(csvFormatRules)) {
    csvFormatRules.columns.forEach(function (col) {
      if (col.system_column === 'customer_code' || col.field === 'customer_code') ccIdx = col.index;
      if (col.system_column === 'amount_ex_tax' || col.field === 'amount_ex_tax') amtIdx = col.index;
      if (col.system_column === 'tax_rate'      || col.field === 'tax_rate')      rateIdx = col.index;
      if (col.system_column === 'tax_amount'    || col.field === 'tax_amount')    taxIdx = col.index;
    });
  } else {
    // デフォルト9列: 顧客コード(0), 日付(1), 品目(2), 数量(3), 単価(4), 税率区分(%)(5), 請求金額(税抜)(6), 消費税(7), 備考(8)
    ccIdx = 0; amtIdx = 6; rateIdx = 5; taxIdx = 7;
  }
  const missing = [];
  if (ccIdx === undefined)   missing.push('customer_code');
  if (amtIdx === undefined)  missing.push('amount_ex_tax');
  if (rateIdx === undefined) missing.push('tax_rate');
  if (missing.length > 0) {
    throw new Error('CSVフォーマットの設定に不備があります。管理者にお問い合わせください。');
  }

  // 加盟店毎に税額を集計
  const expected = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine_(line);
    const cc = (cols[ccIdx] || '').trim();
    if (!cc) continue;

    const amtExTax  = Number(cols[amtIdx] || 0);
    const taxRate   = Number(cols[rateIdx] || 0);
    const rawTax    = taxIdx !== undefined ? cols[taxIdx] : undefined;
    const taxAmount = (rawTax !== undefined && rawTax !== '')
      ? Number(rawTax)
      : roundTax(amtExTax * taxRate / 100);

    if (isNaN(amtExTax) || isNaN(taxRate) || isNaN(taxAmount)) {
      throw new Error('CSV ' + (i + 1) + '行目: 税抜額または税率に数値として解釈できない値が含まれています。半角数字で入力してください。');
    }

    if (!expected[cc]) expected[cc] = { tax10: 0, tax8: 0 };
    if (taxRate === 10)     expected[cc].tax10 += taxAmount;
    else if (taxRate === 8) expected[cc].tax8  += taxAmount;
  }

  // summaryData と比較
  const errors = [];
  // (A) summaryData にあるが CSV にない加盟店を検出
  summaryData.merchantTotals.forEach(function (m) {
    const cc = String(m.customerCode || '');
    const exp = expected[cc];
    if (!exp) {
      errors.push('加盟店 ' + cc + ': CSVに該当データが存在しないため税額を検証できません');
      return;
    }

    const submittedTax10 = Math.round(Number(m.tax10 || 0));
    const submittedTax8  = Math.round(Number(m.tax8 || 0));
    const expectedTax10  = Math.round(exp.tax10);
    const expectedTax8   = Math.round(exp.tax8);

    if (Math.abs(submittedTax10 - expectedTax10) > 1) {
      errors.push('加盟店 ' + cc + ': 税内訳（10%）の調整が±1円を超えています（送信値: ' + submittedTax10 + '円 / 計算値: ' + expectedTax10 + '円）');
    }
    if (Math.abs(submittedTax8 - expectedTax8) > 1) {
      errors.push('加盟店 ' + cc + ': 税内訳（8%）の調整が±1円を超えています（送信値: ' + submittedTax8 + '円 / 計算値: ' + expectedTax8 + '円）');
    }
  });

  // (B) CSV にあるが summaryData にない加盟店を検出（改ざんで加盟店を落とす攻撃を防止）
  const submittedCodes = new Set(summaryData.merchantTotals.map(function (m) { return String(m.customerCode || ''); }));
  Object.keys(expected).forEach(function (cc) {
    if (!submittedCodes.has(cc)) {
      errors.push('加盟店 ' + cc + ': CSVに明細が存在しますが、送信データに含まれていません');
    }
  });

  if (errors.length > 0) {
    logError_('Invoice', 'validateTaxAdjustment_: ' + errors.join('; '));
    throw new Error(errors[0]);
  }
  logInfo_('Invoice', 'validateTaxAdjustment_: OK (merchantTotals=' + summaryData.merchantTotals.length + ')');
}

/**
 * デフォルト9列フォーマット（csv_format_rules が null の卸）向け
 * BQ マルチステートメント・トランザクション SQL を組み立てる。
 * staging テーブルは STAGING_SCHEMA_（固定9列・名前付きカラム）前提で参照する。
 *
 * @param {string} invoiceUuid
 * @param {string} stagingId
 * @param {Object} summaryData
 * @param {Object} remarks
 * @param {Object} accountInfo
 * @param {Object} mallCodeMap
 * @param {string} csvUrl
 * @param {string} projectId
 * @param {string} datasetId
 * @returns {string}
 */
function buildTransactionSql_(invoiceUuid, stagingId, summaryData, remarks, accountInfo, mallCodeMap, csvUrl, projectId, datasetId) {
  const wsId     = Number(accountInfo.wholesaler_id);
  const wsUserId = String(accountInfo.wholesaler_user_id);
  const feeRate  = Number(accountInfo.fee_rate || 0);
  const wt       = summaryData.wholesalerTotal;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(invoiceUuid)) {
    logError_('Invoice', '[buildTransactionSql_] invoiceUuid の形式が不正です: ' + invoiceUuid);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }
  if (!UUID_RE.test(wsUserId)) {
    logError_('Invoice', '[buildTransactionSql_] wholesaler_user_id の形式が不正です: ' + wsUserId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(stagingId)) {
    logError_('Invoice', '[buildTransactionSql_] stagingId に不正な文字が含まれています: ' + stagingId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }
  if (!Number.isInteger(wsId) || wsId <= 0) {
    logError_('Invoice', '[buildTransactionSql_] wholesaler_id が不正です: ' + wsId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }

  ['totalAmount','subtotalAmount','taxAmount','exTax10','tax10','exTax8','tax8','feeAmount','paymentAmount'].forEach(function(f) {
    const v = Number(wt[f] || 0);
    if (!isFinite(v) || v < 0) {
      logError_('Invoice', '[buildTransactionSql_] wholesalerTotal.' + f + ' が不正な値です: ' + wt[f]);
      throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
    }
  });
  summaryData.merchantTotals.forEach(function(m, idx) {
    ['totalAmount','subtotalAmount','taxAmount','exTax10','tax10','exTax8','tax8'].forEach(function(f) {
      const v = Number(m[f] || 0);
      if (!isFinite(v) || v < 0) {
        logError_('Invoice', '[buildTransactionSql_] merchantTotals[' + idx + '].' + f + ' が不正な値です: ' + m[f]);
        throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
      }
    });
  });

  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

  const storeRef     = '`' + projectId + '.' + datasetId + '.store_invoices`';
  const linesRef     = '`' + projectId + '.' + datasetId + '.invoice_lines`';
  const invRef       = '`' + projectId + '.' + datasetId + '.wholesaler_invoices`';
  const stagingRef   = '`' + projectId + '.' + datasetId + '.' + stagingId + '`';
  const merchantsRef = '`' + projectId + '.' + datasetId + '.wholesaler_merchants`';

  const childValues = summaryData.merchantTotals.map((m) => {
    const childUuid = Utilities.getUuid();
    const mallCode  = esc(mallCodeMap[String(m.customerCode)] || '');
    const remark    = esc(remarks[String(m.customerCode)] || '');
    const remarkSql = remark ? "'" + remark + "'" : 'NULL';
    return (
      "('" + childUuid + "', '" + invoiceUuid + "', " + wsId + ", '" + mallCode + "', " +
      Math.round(Number(m.totalAmount))   + ', ' + Math.round(Number(m.subtotalAmount)) + ', ' + Math.round(Number(m.taxAmount))  + ', ' +
      Math.round(Number(m.exTax10 || 0)) + ', ' + Math.round(Number(m.tax10  || 0))    + ', ' +
      Math.round(Number(m.exTax8  || 0)) + ', ' + Math.round(Number(m.tax8   || 0))    + ', ' +
      '0, ' +
      remarkSql + ", 'PENDING_REVIEW', TRUE, '" + esc(wsUserId) + "', CURRENT_TIMESTAMP())"
    );
  });

  const lines = [
    'BEGIN TRANSACTION;',
    '',
    '-- 子: store_invoices（フロントの summaryData.merchantTotals から VALUES 展開）',
    'INSERT INTO ' + storeRef,
    '  (id, wholesaler_invoice_id, wholesaler_id, mall_code,',
    '   total_amount, subtotal_amount, tax_amount,',
    '   standard_tax_target_amount, standard_tax_amount,',
    '   reduced_tax_target_amount, reduced_tax_amount,',
    '   non_taxable_amount, wholesaler_remark,',
    '   backoffice_review_status, is_latest,',
    '   final_updated_by, created_at)',
    'VALUES',
    childValues.join(',\n') + ';',
    '',
    '-- 孫: invoice_lines（staging × wholesaler_merchants × store_invoices JOIN）',
    '-- staging は STAGING_SCHEMA_（固定9列・名前付きカラム）前提で参照する',
    'INSERT INTO ' + linesRef,
    '  (id, invoice_item_row, store_invoice_id,',
    '   transaction_date, item_name, quantity, quantity_unit, unit_price,',
    '   tax_category, line_amount_excluding_tax, line_tax_amount, line_note)',
    'SELECT',
    '  GENERATE_UUID(),',
    '  ROW_NUMBER() OVER (PARTITION BY si.id ORDER BY s.transaction_date),',
    '  si.id,',
    '  s.transaction_date, s.item_name, s.quantity, CAST(NULL AS STRING), s.unit_price,',
    '  s.tax_rate, s.amount_ex_tax,',
    '  s.tax_amount,',
    '  s.invoice_detail_remark',
    'FROM ' + stagingRef + ' s',
    'JOIN ' + merchantsRef + ' wm',
    '  ON wm.customer_code = s.customer_code',
    '  AND wm.wholesaler_id = ' + wsId,
    '  AND wm.deleted_at IS NULL',
    'JOIN ' + storeRef + ' si',
    '  ON si.mall_code = wm.mall_code',
    "  AND si.wholesaler_invoice_id = '" + invoiceUuid + "';",
    '',
    '-- 親: wholesaler_invoices（最後に INSERT。失敗しても子・孫はロールバックされる）',
    'INSERT INTO ' + invRef,
    '  (id, wholesaler_user_id, wholesaler_id, wholesaler_invoice_date,',
    '   wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
    '   wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount,',
    '   wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount,',
    '   wholesaler_non_taxable_amount,',
    '   wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
    '   handover_matter, wholesaler_invoice_csv_url, created_at)',
    'VALUES',
    "  ('" + invoiceUuid + "', '" + esc(wsUserId) + "', " + wsId + ", CURRENT_DATE('Asia/Tokyo'),",
    '   ' + Math.round(Number(wt.totalAmount))   + ', ' + Math.round(Number(wt.subtotalAmount)) + ', ' + Math.round(Number(wt.taxAmount))  + ',',
    '   ' + Math.round(Number(wt.exTax10 || 0)) + ', ' + Math.round(Number(wt.tax10 || 0)) + ',',
    '   ' + Math.round(Number(wt.exTax8  || 0)) + ', ' + Math.round(Number(wt.tax8  || 0)) + ',',
    '   0,',
    '   ' + feeRate + ', ' + Math.round(Number(wt.feeAmount)) + ', ' + Math.round(Number(wt.paymentAmount)) + ',',
    "   NULL, '" + esc(csvUrl) + "', CURRENT_TIMESTAMP());",
    '',
    'COMMIT;',
  ];
  return lines.join('\n');
}

/**
 * csv_format_rules から BQ Load Job 用の staging スキーマを動的生成する。
 *
 * 返り値の意味:
 *   undefined … csv_format_rules が null / 空（デフォルト卸）
 *               → loadCsvToBq_ が STAGING_SCHEMA_（固定9列・名前付きカラム）を使用
 *   Object    … 新形式（columns 配列あり）
 *               → loadCsvToBq_ が string_field_0〜N の全列 STRING 明示スキーマを使用
 *               autodetect: true に委ねると BQ が DATE/INT64 等に推論してしまい、
 *               後段の be_csv_mapper.js（NULLIF/PARSE_DATE 等）が型不一致で失敗するため。
 *
 * 新形式以外の非 null 値（旧形式・不正値）は throw する。
 * そのような値が渡された場合は DB 登録前のヘッダー検証でも既に失敗しているはずだが、
 * 二重防衛として明示的なエラーメッセージで検知する。
 *
 * @param {Object|null} csvFormatRules - accountInfo.csv_format_rules
 * @returns {Object|undefined}
 * @throws {Error} 新形式でも null でもない不正な csv_format_rules が渡された場合
 */
function buildStagingSchema_(csvFormatRules) {
  // null / 未設定 → デフォルト卸。固定スキーマ（STAGING_SCHEMA_）を使用する。
  if (!csvFormatRules || Object.keys(csvFormatRules).length === 0) {
    return undefined;
  }

  // 新形式（columns 配列あり）→ 全列 STRING の明示スキーマを生成する。
  // autodetect: true に任せると列が DATE/INT64 に推論される可能性があり、
  // 後段の NULLIF(...,'') や PARSE_DATE(...) が型不一致で失敗する。
  // columns の最大 index + 1 列分を string_field_0〜N として STRING で定義する。
  if (isNewFormatRules_(csvFormatRules)) { // be_csv_mapper.js
    // col.index は string_field_N の N として BQ スキーマに直接使われるため、
    // 型・範囲を事前検証する。
    //   - 非整数・負数 → 不正なフィールド名になる
    //   - 極端に大きい値 → for ループが大量回転してメモリを圧迫する
    // 上限 200 は現実的な CSV 列数の最大値として設定（Excel 最大 16,384 列より十分小さい）。
    const MAX_COL_INDEX = 200;
    csvFormatRules.columns.forEach(function(col, i) {
      if (!Number.isInteger(col.index) || col.index < 0) {
        logError_('Schema', 'columns[' + i + '].index が不正です。index=' + col.index + ', col=' + JSON.stringify(col));
        throw new Error(
          'CSVフォーマットの設定に不備があります。管理者にお問い合わせください。'
        );
      }
      if (col.index > MAX_COL_INDEX) {
        logError_('Schema', 'columns[' + i + '].index が上限(' + MAX_COL_INDEX + ')を超えています。index=' + col.index + ', col=' + JSON.stringify(col));
        throw new Error(
          'CSVフォーマットの設定に不備があります。管理者にお問い合わせください。'
        );
      }
    });

    const maxIndex = csvFormatRules.columns.reduce(function(max, col) {
      return Math.max(max, col.index);
    }, 0);
    const fields = [];
    for (let i = 0; i <= maxIndex; i++) {
      fields.push({ name: 'string_field_' + i, type: 'STRING' });
    }
    return { fields: fields };
  }

  // 新形式でも null でもない値（不正値）は処理できない。
  // ヘッダー検証より後に呼ばれるため通常はここに到達しないが、
  // 二重防衛として明示的に throw する。
  throw new Error(
    'CSVフォーマットの設定に不備があります。管理者にお問い合わせください。'
  );
}

/**
 * merchant_mappings から customer_code → mall_code のマップを構築する。
 * summaryData の customerCode が全て merchant_mappings に存在するかも検証する（改ざん防止）。
 *
 * @param {Array<Object>} mappings       - accountInfo.merchant_mappings
 * @param {Array<Object>} merchantTotals - summaryData.merchantTotals
 * @returns {Object} { [customerCode]: mallCode }
 * @throws {Error} 未登録の customerCode が summaryData に含まれる場合
 */
function buildMallCodeMap_(mappings, merchantTotals) {
  const map = {};
  (mappings || []).forEach((m) => {
    if (m.is_active !== false) map[String(m.customer_code)] = String(m.mall_code || '');
  });
  (merchantTotals || []).forEach((m) => {
    const cc = String(m.customerCode || '');
    if (!(cc in map)) {
      throw new Error('顧客コード「' + cc + '」は登録されていません。CSVの顧客コードを確認してください。');
    }
    if (!map[cc]) {
      throw new Error('顧客コード「' + cc + '」の店舗設定が完了していません。管理者にお問い合わせください。');
    }
  });
  return map;
}

/**
 * merchantTotals から wholesalerTotal を再計算する。
 * BE防御フィルタで merchantTotals を絞り込んだ後に呼び出す。
 *
 * @param {Array<Object>} merchantTotals
 * @returns {Object} wholesalerTotal
 */
function recalcWholesalerTotal_(merchantTotals) {
  const wt = { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };
  merchantTotals.forEach(function (m) {
    wt.totalAmount    += Number(m.totalAmount || 0);
    wt.subtotalAmount += Number(m.subtotalAmount || 0);
    wt.taxAmount      += Number(m.taxAmount || 0);
    wt.exTax10        += Number(m.exTax10 || 0);
    wt.tax10          += Number(m.tax10 || 0);
    wt.exTax8         += Number(m.exTax8 || 0);
    wt.tax8           += Number(m.tax8 || 0);
  });
  return wt;
}

/**
 * 差し戻し・否認後の再送信用 SQL を組み立てる。
 * sendInvoiceData の buildTransactionSql_ と同じ構造だが:
 *   - wholesaler_invoices には既存の parentInvoiceId を使ってINSERT（新しい親は作らない）
 *   - 対象の store_invoices レコードを is_latest = FALSE にUPDATE
 *   - 否認の場合は wholesaler_handover を store_invoices に追加
 *
 * @param {string} parentInvoiceId - 詳細画面で表示中の wholesaler_invoices.id
 * @param {string} storeInvoiceId  - 差し戻し/否認対象の store_invoices.id
 * @param {string} stagingId
 * @param {Object} summaryData
 * @param {Object} remarks
 * @param {string|null} wholesalerHandover - 否認の場合の加盟店との合意内容
 * @param {Object} accountInfo
 * @param {Object} mallCodeMap
 * @param {string} csvUrl
 * @param {string} projectId
 * @param {string} datasetId
 * @returns {string}
 */
function buildResubmitTransactionSql_(parentInvoiceId, storeInvoiceId, stagingId, summaryData, remarks, wholesalerHandover, accountInfo, mallCodeMap, csvUrl, projectId, datasetId, latestWi, oldStoreAmounts) {
  const wsId     = Number(accountInfo.wholesaler_id);
  const wsUserId = String(accountInfo.wholesaler_user_id);
  const feeRate  = Number(accountInfo.fee_rate || 0);
  const roundFee_ = (function() {
    const m = accountInfo.tax_rounding_method || 'floor';
    if (m === 'ceil')  return Math.ceil;
    if (m === 'round') return Math.round;
    return Math.floor;
  })();
  const wt       = summaryData.wholesalerTotal;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(parentInvoiceId)) {
    logError_('Invoice', '[buildResubmitTransactionSql_] parentInvoiceId の形式が不正です: ' + parentInvoiceId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }
  if (!UUID_RE.test(storeInvoiceId)) {
    logError_('Invoice', '[buildResubmitTransactionSql_] storeInvoiceId の形式が不正です: ' + storeInvoiceId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(stagingId)) {
    logError_('Invoice', '[buildResubmitTransactionSql_] stagingId に不正な文字が含まれています: ' + stagingId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }

  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

  const storeRef     = '`' + projectId + '.' + datasetId + '.store_invoices`';
  const linesRef     = '`' + projectId + '.' + datasetId + '.invoice_lines`';
  const invRef       = '`' + projectId + '.' + datasetId + '.wholesaler_invoices`';
  const stagingRef   = '`' + projectId + '.' + datasetId + '.' + stagingId + '`';
  const merchantsRef = '`' + projectId + '.' + datasetId + '.wholesaler_merchants`';

  const newWiUuid = Utilities.getUuid();

  const handoverSql = wholesalerHandover
    ? "'" + esc(wholesalerHandover) + "'"
    : 'NULL';

  const childUuids = [];
  const childValues = summaryData.merchantTotals.map((m) => {
    const childUuid = Utilities.getUuid();
    childUuids.push("'" + childUuid + "'");
    const mallCode  = esc(mallCodeMap[String(m.customerCode)] || '');
    const remark    = esc(remarks[String(m.customerCode)] || '');
    const remarkSql = remark ? "'" + remark + "'" : 'NULL';
    return (
      "('" + childUuid + "', '" + newWiUuid + "', " + wsId + ", '" + mallCode + "', " +
      Math.round(Number(m.totalAmount))   + ', ' + Math.round(Number(m.subtotalAmount)) + ', ' + Math.round(Number(m.taxAmount))  + ', ' +
      Math.round(Number(m.exTax10 || 0)) + ', ' + Math.round(Number(m.tax10  || 0))    + ', ' +
      Math.round(Number(m.exTax8  || 0)) + ', ' + Math.round(Number(m.tax8   || 0))    + ', ' +
      '0, ' +
      remarkSql + ', ' + handoverSql + ", 'PENDING_REVIEW', TRUE, '" + esc(wsUserId) + "', CURRENT_TIMESTAMP())"
    );
  });

  // 金額再計算: 最新WIの金額 − 旧対象store金額 + 新CSV金額
  const amountFields = ['totalAmount','subtotalAmount','taxAmount','exTax10','tax10','exTax8','tax8'];
  const wiFieldMap = {
    totalAmount: 'wholesaler_total_amount', subtotalAmount: 'wholesaler_subtotal_amount',
    taxAmount: 'wholesaler_tax_amount', exTax10: 'wholesaler_standard_tax_target_amount',
    tax10: 'wholesaler_standard_tax_amount', exTax8: 'wholesaler_reduced_tax_target_amount',
    tax8: 'wholesaler_reduced_tax_amount',
  };
  const newAmounts = {};
  amountFields.forEach(function (f) {
    newAmounts[f] = Math.round(Number(latestWi[wiFieldMap[f]] || 0) - Number(oldStoreAmounts[f] || 0) + Number(wt[f] || 0));
  });
  newAmounts.nonTaxable = Number(latestWi.wholesaler_non_taxable_amount || 0);
  const newFeeAmount = roundFee_(newAmounts.totalAmount * feeRate / 100);
  const newPaymentAmount = newAmounts.totalAmount - newFeeAmount;

  const lines = [
    'BEGIN TRANSACTION;',
    '',
    '-- 旧レコードを is_latest = FALSE に更新',
    'UPDATE ' + storeRef,
    'SET is_latest = FALSE',
    "WHERE id = '" + storeInvoiceId + "'",
    '  AND wholesaler_id = ' + wsId,
    "  AND wholesaler_invoice_id IN (SELECT id FROM " + invRef + " WHERE id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "')",
    '  AND is_latest = TRUE;',
    '',
    '-- 新しい store_invoices を INSERT',
    'INSERT INTO ' + storeRef,
    '  (id, wholesaler_invoice_id, wholesaler_id, mall_code,',
    '   total_amount, subtotal_amount, tax_amount,',
    '   standard_tax_target_amount, standard_tax_amount,',
    '   reduced_tax_target_amount, reduced_tax_amount,',
    '   non_taxable_amount, wholesaler_remark, wholesaler_handover,',
    '   backoffice_review_status, is_latest,',
    '   final_updated_by, created_at)',
    'VALUES',
    childValues.join(',\n') + ';',
    '',
    '-- invoice_lines を INSERT',
    'INSERT INTO ' + linesRef,
    '  (id, invoice_item_row, store_invoice_id,',
    '   transaction_date, item_name, quantity, quantity_unit, unit_price,',
    '   tax_category, line_amount_excluding_tax, line_tax_amount, line_note)',
    'SELECT',
    '  GENERATE_UUID(),',
    '  ROW_NUMBER() OVER (PARTITION BY si.id ORDER BY s.transaction_date),',
    '  si.id,',
    '  s.transaction_date, s.item_name, s.quantity, CAST(NULL AS STRING), s.unit_price,',
    '  s.tax_rate, s.amount_ex_tax,',
    '  s.tax_amount,',
    '  s.invoice_detail_remark',
    'FROM ' + stagingRef + ' s',
    'JOIN ' + merchantsRef + ' wm',
    '  ON wm.customer_code = s.customer_code',
    '  AND wm.wholesaler_id = ' + wsId,
    '  AND wm.deleted_at IS NULL',
    'JOIN ' + storeRef + ' si',
    '  ON si.id IN (' + childUuids.join(', ') + ')',
    '  AND si.mall_code = wm.mall_code;',
    '',
    '-- 新しい wholesaler_invoices を INSERT（金額再計算済み）',
    'INSERT INTO ' + invRef,
    '  (id, wholesaler_user_id, wholesaler_id, wholesaler_invoice_date,',
    '   wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
    '   wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount,',
    '   wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount,',
    '   wholesaler_non_taxable_amount,',
    '   wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
    '   wholesaler_invoice_id, wholesaler_invoice_csv_url, created_at)',
    'VALUES',
    "  ('" + newWiUuid + "', '" + esc(wsUserId) + "', " + wsId + ", '" + latestWi.wholesaler_invoice_date + "',",
    '   ' + newAmounts.totalAmount + ', ' + newAmounts.subtotalAmount + ', ' + newAmounts.taxAmount + ',',
    '   ' + newAmounts.exTax10 + ', ' + newAmounts.tax10 + ',',
    '   ' + newAmounts.exTax8 + ', ' + newAmounts.tax8 + ',',
    '   ' + newAmounts.nonTaxable + ',',
    '   ' + feeRate + ', ' + newFeeAmount + ', ' + newPaymentAmount + ',',
    "   '" + parentInvoiceId + "', '" + esc(csvUrl) + "', CURRENT_TIMESTAMP());",
    '',
    'COMMIT;',
  ];
  return lines.join('\n');
}

/**
 * 差し戻し・否認後の修正CSV再送信。
 * 既存の wholesaler_invoices.id（parentInvoiceId）はそのまま使い、
 * store_invoices を新規INSERT、旧レコードの is_latest を FALSE に更新する。
 *
 * @param {string}      rawCsvBase64      - 元CSVのBase64
 * @param {string}      utf8CsvBase64     - UTF-8変換済みCSVのBase64
 * @param {Object}      summaryData       - { wholesalerTotal, merchantTotals }
 * @param {Object}      remarks           - { [customerCode]: string }
 * @param {string}      parentInvoiceId   - wholesaler_invoices.id（詳細画面のID）
 * @param {string}      storeInvoiceId    - 差し戻し/否認対象の store_invoices.id
 * @param {string|null} wholesalerHandover - 否認時の加盟店との合意内容
 * @returns {{ status: 'success', data: Object }}
 */
function resubmitInvoiceData(rawCsvBase64, utf8CsvBase64, summaryData, remarks, parentInvoiceId, storeInvoiceId, wholesalerHandover) {
  try {
    const accountInfo = getServerAccountInfo_();
    logInfo_('Invoice', 'resubmitInvoiceData 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', parentInvoiceId=' + parentInvoiceId + ', storeInvoiceId=' + storeInvoiceId);
    const mappings    = accountInfo.merchant_mappings || [];

    if (!rawCsvBase64)  throw new Error('CSVデータの送信に失敗しました。ファイルを再度選択してアップロードしてください。');
    if (!utf8CsvBase64) throw new Error('CSVデータの送信に失敗しました。ファイルを再度選択してアップロードしてください。');
    if (!parentInvoiceId) throw new Error('請求情報の取得に失敗しました。ページを再読み込みしてください。');
    if (!storeInvoiceId)  throw new Error('対象の加盟店請求情報の取得に失敗しました。ページを再読み込みしてください。');
    if (!summaryData || !summaryData.wholesalerTotal || !Array.isArray(summaryData.merchantTotals)) {
      throw new Error('summaryData の形式が不正です');
    }
    if (summaryData.merchantTotals.length === 0) {
      throw new Error('summaryData.merchantTotals が空です');
    }

    // ── 異議申立期間（OBJECTION_PERIOD）チェック ─────────────────────────────
    const parentSummary = fetchInvoiceDetailSummary_(parentInvoiceId, accountInfo.wholesaler_id);
    if (parentSummary && parentSummary.objection_end_at) {
      const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
      if (today > String(parentSummary.objection_end_at).slice(0, 10)) {
        throw new Error('異議申立期間を過ぎているため、再アップロードできません。');
      }
    }

    // ── BE防御: 対象 storeInvoiceId の mall_code 以外を除外 ──
    const targetMallCode = fetchStoreInvoiceMallCode_(storeInvoiceId, accountInfo.wholesaler_id, parentInvoiceId);
    if (targetMallCode) {
      const customerToMall = {};
      (mappings || []).forEach(function (m) {
        if (m.customer_code && m.mall_code) customerToMall[String(m.customer_code)] = String(m.mall_code);
      });
      summaryData.merchantTotals = summaryData.merchantTotals.filter(function (m) {
        return customerToMall[String(m.customerCode)] === targetMallCode;
      });
      if (summaryData.merchantTotals.length === 0) {
        throw new Error('対象加盟店のデータが含まれていません');
      }
      summaryData.wholesalerTotal = recalcWholesalerTotal_(summaryData.merchantTotals);
    }

    const stagingSchema = buildStagingSchema_(accountInfo.csv_format_rules);
    const mallCodeMap   = buildMallCodeMap_(mappings, summaryData.merchantTotals);

    // ヘッダー検証
    const utf8Bytes = Utilities.base64Decode(utf8CsvBase64);
    const csvText   = Utilities.newBlob(utf8Bytes, MimeType.CSV).getDataAsString('UTF-8');
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      validateCsvHeaderByRules_(csvText, accountInfo.csv_format_rules);
    } else {
      validateCsvHeader_(csvText, getExpectedHeaders_());
    }

    // ── 税額 ±1円バリデーション ────────────────────────────────────────────
    validateTaxAdjustment_(csvText, summaryData, accountInfo.csv_format_rules, accountInfo.tax_rounding_method || 'floor');

    const stagingId = 'staging_invoice_lines_' + Utilities.getUuid().replace(/-/g, '_');
    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const location  = config.bqLocation;
    const now       = new Date();

    // Drive 保存
    const rawBytes    = Utilities.base64Decode(rawCsvBase64);
    const rootFolder  = DriveApp.getFolderById(config.driveFolderId);
    const folderName  = accountInfo.wholesaler_id + '_' + accountInfo.wholesaler_name;
    const userFolder  = getOrCreateSubFolder_(rootFolder, folderName);
    const monthFolder = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName    = formatTimestamp_(now) + '_resubmit.csv';
    const saveBlob    = Utilities.newBlob(rawBytes, MimeType.CSV, fileName);
    const csvFile     = monthFolder.createFile(saveBlob);
    const csvUrl      = csvFile.getUrl();
    Logger.log('[Drive] resubmit 保存完了: ' + csvUrl);

    // BQ Load Job
    const jobId = loadCsvToBq_(projectId, datasetId, stagingId, utf8Bytes, stagingSchema, location);
    waitForLoadJob_(projectId, jobId, location);

    // トランザクション SQL 実行
    // 最新の wholesaler_invoices と旧対象 store_invoices の金額を BQ から取得（再計算用）
    const latestWi = fetchLatestWholesalerInvoice_(parentInvoiceId, accountInfo.wholesaler_id);
    if (!latestWi) throw new Error('請求情報が見つかりませんでした。ページを再読み込みしてください。');
    const oldStoreAmounts = fetchTargetStoreInvoiceAmounts_(parentInvoiceId, accountInfo.wholesaler_id, [storeInvoiceId]);

    let sql;
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      sql = buildMappedResubmitTransactionSql_({
        parentInvoiceId, storeInvoiceId, stagingId, summaryData, remarks,
        wholesalerHandover: wholesalerHandover || null,
        accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
        csvFormatRules: accountInfo.csv_format_rules,
        latestWi, oldStoreAmounts,
      });
    } else {
      sql = buildResubmitTransactionSql_(
        parentInvoiceId, storeInvoiceId, stagingId, summaryData, remarks,
        wholesalerHandover || null, accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
        latestWi, oldStoreAmounts
      );
    }
    Logger.log('[BQ] resubmit SQL:\n' + sql);
    runTransactionSql_(projectId, sql);

    // staging DROP
    try {
      dropStagingTable_(projectId, datasetId, stagingId);
    } catch (dropErr) {
      logError_('Invoice', 'resubmitInvoiceData staging DROP 失敗（手動削除が必要）', dropErr);
    }

    logInfo_('Invoice', 'resubmitInvoiceData 完了: parentInvoiceId=' + parentInvoiceId);
    return success_({ csv_url: csvUrl });
  } catch (err) {
    logError_('Invoice', 'resubmitInvoiceData', err);
    throw err;
  }
}

// =============================================================================
// 一括再送信（差し戻し・否認の全加盟店を一括で再送信）
// =============================================================================

/**
 * 一括再送信用のトランザクション SQL を組み立てる。
 * 全要対応 store_invoices を is_latest=FALSE → 新規 INSERT → wholesaler_invoices INSERT（金額再計算）。
 *
 * @param {string}  parentInvoiceId  - 大元の wholesaler_invoices.id
 * @param {string}  stagingId
 * @param {Object}  summaryData
 * @param {Object}  remarks
 * @param {Object}  accountInfo
 * @param {Object}  mallCodeMap
 * @param {string}  csvUrl
 * @param {string}  projectId
 * @param {string}  datasetId
 * @param {Object}  latestWi         - 最新の wholesaler_invoices レコード
 * @param {Object}  oldStoreAmounts  - 旧要対応 store_invoices の合計金額
 * @returns {string} SQL
 */
function buildBulkResubmitTransactionSql_(parentInvoiceId, stagingId, summaryData, remarks, handovers, accountInfo, mallCodeMap, csvUrl, projectId, datasetId, latestWi, oldStoreAmounts) {
  const wsId     = Number(accountInfo.wholesaler_id);
  const wsUserId = String(accountInfo.wholesaler_user_id);
  const feeRate  = Number(accountInfo.fee_rate || 0);
  const roundFee_ = (function() {
    const m = accountInfo.tax_rounding_method || 'floor';
    if (m === 'ceil')  return Math.ceil;
    if (m === 'round') return Math.round;
    return Math.floor;
  })();
  const wt       = summaryData.wholesalerTotal;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(parentInvoiceId)) {
    logError_('Invoice', '[buildBulkResubmitTransactionSql_] parentInvoiceId の形式が不正です: ' + parentInvoiceId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(stagingId)) {
    logError_('Invoice', '[buildBulkResubmitTransactionSql_] stagingId に不正な文字が含まれています: ' + stagingId);
    throw new Error('処理中にエラーが発生しました。ページを再読み込みして再度お試しください。');
  }

  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

  const storeRef     = '`' + projectId + '.' + datasetId + '.store_invoices`';
  const linesRef     = '`' + projectId + '.' + datasetId + '.invoice_lines`';
  const invRef       = '`' + projectId + '.' + datasetId + '.wholesaler_invoices`';
  const stagingRef   = '`' + projectId + '.' + datasetId + '.' + stagingId + '`';
  const merchantsRef = '`' + projectId + '.' + datasetId + '.wholesaler_merchants`';

  const newWiUuid = Utilities.getUuid();

  const childUuids = [];
  const childValues = summaryData.merchantTotals.map((m) => {
    const childUuid = Utilities.getUuid();
    childUuids.push("'" + childUuid + "'");
    const mallCode  = esc(mallCodeMap[String(m.customerCode)] || '');
    const remark    = esc(remarks[String(m.customerCode)] || '');
    const remarkSql = remark ? "'" + remark + "'" : 'NULL';
    const handover  = handovers[String(m.customerCode)] || '';
    const handoverSql = handover ? "'" + esc(handover) + "'" : 'NULL';
    return (
      "('" + childUuid + "', '" + newWiUuid + "', " + wsId + ", '" + mallCode + "', " +
      Math.round(Number(m.totalAmount))   + ', ' + Math.round(Number(m.subtotalAmount)) + ', ' + Math.round(Number(m.taxAmount))  + ', ' +
      Math.round(Number(m.exTax10 || 0)) + ', ' + Math.round(Number(m.tax10  || 0))    + ', ' +
      Math.round(Number(m.exTax8  || 0)) + ', ' + Math.round(Number(m.tax8   || 0))    + ', ' +
      '0, ' +
      remarkSql + ', ' + handoverSql + ", 'PENDING_REVIEW', TRUE, '" + esc(wsUserId) + "', CURRENT_TIMESTAMP())"
    );
  });

  // 金額再計算: 最新WIの金額 − 旧対象store金額 + 新CSV金額
  const amountFields = ['totalAmount','subtotalAmount','taxAmount','exTax10','tax10','exTax8','tax8'];
  const wiFieldMap = {
    totalAmount: 'wholesaler_total_amount', subtotalAmount: 'wholesaler_subtotal_amount',
    taxAmount: 'wholesaler_tax_amount', exTax10: 'wholesaler_standard_tax_target_amount',
    tax10: 'wholesaler_standard_tax_amount', exTax8: 'wholesaler_reduced_tax_target_amount',
    tax8: 'wholesaler_reduced_tax_amount',
  };
  const newAmounts = {};
  amountFields.forEach(function (f) {
    newAmounts[f] = Math.round(Number(latestWi[wiFieldMap[f]] || 0) - Number(oldStoreAmounts[f] || 0) + Number(wt[f] || 0));
  });
  newAmounts.nonTaxable = Number(latestWi.wholesaler_non_taxable_amount || 0);
  const newFeeAmount = roundFee_(newAmounts.totalAmount * feeRate / 100);
  const newPaymentAmount = newAmounts.totalAmount - newFeeAmount;

  const lines = [
    'BEGIN TRANSACTION;',
    '',
    '-- ① 差し戻し store_invoices を is_latest = FALSE に更新',
    'UPDATE ' + storeRef,
    'SET is_latest = FALSE',
    "WHERE wholesaler_invoice_id IN (SELECT id FROM " + invRef + " WHERE id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "')",
    "  AND backoffice_review_status = 'RETURNED'",
    '  AND is_latest = TRUE;',
    '',
    '-- ② 否認 store_invoices を is_latest = FALSE に更新',
    'UPDATE ' + storeRef,
    'SET is_latest = FALSE',
    "WHERE wholesaler_invoice_id IN (SELECT id FROM " + invRef + " WHERE id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "')",
    "  AND backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED'",
    "  AND invoice_status = 'DISPUTED'",
    '  AND is_latest = TRUE;',
    '',
    '-- ③ 新しい store_invoices を INSERT',
    'INSERT INTO ' + storeRef,
    '  (id, wholesaler_invoice_id, wholesaler_id, mall_code,',
    '   total_amount, subtotal_amount, tax_amount,',
    '   standard_tax_target_amount, standard_tax_amount,',
    '   reduced_tax_target_amount, reduced_tax_amount,',
    '   non_taxable_amount, wholesaler_remark, wholesaler_handover,',
    '   backoffice_review_status, is_latest,',
    '   final_updated_by, created_at)',
    'VALUES',
    childValues.join(',\n') + ';',
    '',
    '-- ④ invoice_lines を INSERT',
    'INSERT INTO ' + linesRef,
    '  (id, invoice_item_row, store_invoice_id,',
    '   transaction_date, item_name, quantity, quantity_unit, unit_price,',
    '   tax_category, line_amount_excluding_tax, line_tax_amount, line_note)',
    'SELECT',
    '  GENERATE_UUID(),',
    '  ROW_NUMBER() OVER (PARTITION BY si.id ORDER BY s.transaction_date),',
    '  si.id,',
    '  s.transaction_date, s.item_name, s.quantity, CAST(NULL AS STRING), s.unit_price,',
    '  s.tax_rate, s.amount_ex_tax,',
    '  s.tax_amount,',
    '  s.invoice_detail_remark',
    'FROM ' + stagingRef + ' s',
    'JOIN ' + merchantsRef + ' wm',
    '  ON wm.customer_code = s.customer_code',
    '  AND wm.wholesaler_id = ' + wsId,
    '  AND wm.deleted_at IS NULL',
    'JOIN ' + storeRef + ' si',
    '  ON si.id IN (' + childUuids.join(', ') + ')',
    '  AND si.mall_code = wm.mall_code;',
    '',
    '-- ⑤ 新しい wholesaler_invoices を INSERT（金額再計算済み）',
    'INSERT INTO ' + invRef,
    '  (id, wholesaler_user_id, wholesaler_id, wholesaler_invoice_date,',
    '   wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
    '   wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount,',
    '   wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount,',
    '   wholesaler_non_taxable_amount,',
    '   wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
    '   wholesaler_invoice_id, wholesaler_invoice_csv_url, created_at)',
    'VALUES',
    "  ('" + newWiUuid + "', '" + esc(wsUserId) + "', " + wsId + ", '" + latestWi.wholesaler_invoice_date + "',",
    '   ' + newAmounts.totalAmount + ', ' + newAmounts.subtotalAmount + ', ' + newAmounts.taxAmount + ',',
    '   ' + newAmounts.exTax10 + ', ' + newAmounts.tax10 + ',',
    '   ' + newAmounts.exTax8 + ', ' + newAmounts.tax8 + ',',
    '   ' + newAmounts.nonTaxable + ',',
    '   ' + feeRate + ', ' + newFeeAmount + ', ' + newPaymentAmount + ',',
    "   '" + parentInvoiceId + "', '" + esc(csvUrl) + "', CURRENT_TIMESTAMP());",
    '',
    'COMMIT;',
  ];
  return lines.join('\n');
}

/**
 * 差し戻し・否認の全加盟店を一括で再送信する。
 * CSV をアップロードし、全要対応 store_invoices を is_latest=FALSE → 新規INSERT、
 * wholesaler_invoices を金額再計算してINSERTする。
 *
 * @param {string} rawCsvBase64   - 元CSVのBase64
 * @param {string} utf8CsvBase64  - UTF-8変換済みCSVのBase64
 * @param {Object} summaryData    - { wholesalerTotal, merchantTotals }
 * @param {Object} remarks        - { [customerCode]: string }
 * @param {string} parentInvoiceId - 大元の wholesaler_invoices.id
 * @returns {{ status: 'success', data: Object }}
 */
function bulkResubmitInvoiceData(rawCsvBase64, utf8CsvBase64, summaryData, remarks, parentInvoiceId, handovers) {
  try {
    const accountInfo = getServerAccountInfo_();
    logInfo_('Invoice', 'bulkResubmitInvoiceData 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', parentInvoiceId=' + parentInvoiceId);
    const mappings    = accountInfo.merchant_mappings || [];

    if (!rawCsvBase64)     throw new Error('CSVデータの送信に失敗しました。ファイルを再度選択してアップロードしてください。');
    if (!utf8CsvBase64)    throw new Error('CSVデータの送信に失敗しました。ファイルを再度選択してアップロードしてください。');
    if (!parentInvoiceId)  throw new Error('請求情報の取得に失敗しました。ページを再読み込みしてください。');
    if (!summaryData || !summaryData.wholesalerTotal || !Array.isArray(summaryData.merchantTotals)) {
      throw new Error('送信データに不備があります。ページを再読み込みして再度お試しください。');
    }
    if (summaryData.merchantTotals.length === 0) {
      throw new Error('送信対象の加盟店データがありません。CSVを確認してください。');
    }

    // ── 異議申立期間（OBJECTION_PERIOD）チェック ─────────────────────────────
    const parentSummary = fetchInvoiceDetailSummary_(parentInvoiceId, accountInfo.wholesaler_id);
    if (parentSummary && parentSummary.objection_end_at) {
      const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
      if (today > String(parentSummary.objection_end_at).slice(0, 10)) {
        throw new Error('異議申立期間を過ぎているため、再アップロードできません。');
      }
    }

    // ── BE防御: 要対応の mall_code 一覧を取得し、summaryData をフィルタ ──
    const eligibleMallCodes = new Set(fetchActionRequiredMallCodes_(parentInvoiceId, accountInfo.wholesaler_id));
    const customerToMall = {};
    (mappings || []).forEach(function (m) {
      if (m.customer_code && m.mall_code) customerToMall[String(m.customer_code)] = String(m.mall_code);
    });
    summaryData.merchantTotals = summaryData.merchantTotals.filter(function (m) {
      const mc = customerToMall[String(m.customerCode)] || '';
      return eligibleMallCodes.has(mc);
    });
    if (summaryData.merchantTotals.length === 0) {
      throw new Error('要対応の加盟店データが含まれていません');
    }
    summaryData.wholesalerTotal = recalcWholesalerTotal_(summaryData.merchantTotals);

    const stagingSchema = buildStagingSchema_(accountInfo.csv_format_rules);
    const mallCodeMap   = buildMallCodeMap_(mappings, summaryData.merchantTotals);

    // ヘッダー検証
    const utf8Bytes = Utilities.base64Decode(utf8CsvBase64);
    const csvText   = Utilities.newBlob(utf8Bytes, MimeType.CSV).getDataAsString('UTF-8');
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      validateCsvHeaderByRules_(csvText, accountInfo.csv_format_rules);
    } else {
      validateCsvHeader_(csvText, getExpectedHeaders_());
    }

    // ── 税額 ±1円バリデーション ────────────────────────────────────────────
    validateTaxAdjustment_(csvText, summaryData, accountInfo.csv_format_rules, accountInfo.tax_rounding_method || 'floor');

    const stagingId = 'staging_invoice_lines_' + Utilities.getUuid().replace(/-/g, '_');
    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const location  = config.bqLocation;
    const now       = new Date();

    // Drive 保存
    const rawBytes    = Utilities.base64Decode(rawCsvBase64);
    const rootFolder  = DriveApp.getFolderById(config.driveFolderId);
    const folderName  = accountInfo.wholesaler_id + '_' + accountInfo.wholesaler_name;
    const userFolder  = getOrCreateSubFolder_(rootFolder, folderName);
    const monthFolder = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName    = formatTimestamp_(now) + '_bulk_resubmit.csv';
    const saveBlob    = Utilities.newBlob(rawBytes, MimeType.CSV, fileName);
    const csvFile     = monthFolder.createFile(saveBlob);
    const csvUrl      = csvFile.getUrl();
    Logger.log('[Drive] bulk_resubmit 保存完了: ' + csvUrl);

    // BQ Load Job
    const jobId = loadCsvToBq_(projectId, datasetId, stagingId, utf8Bytes, stagingSchema, location);
    waitForLoadJob_(projectId, jobId, location);

    // 最新の wholesaler_invoices と旧対象 store_invoices の金額を取得（再計算用）
    const latestWi = fetchLatestWholesalerInvoice_(parentInvoiceId, accountInfo.wholesaler_id);
    if (!latestWi) throw new Error('請求情報が見つかりませんでした。ページを再読み込みしてください。');
    const oldStoreAmounts = fetchTargetStoreInvoiceAmounts_(parentInvoiceId, accountInfo.wholesaler_id, null);

    // トランザクション SQL 実行
    let sql;
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      sql = buildMappedBulkResubmitTransactionSql_({
        parentInvoiceId, stagingId, summaryData, remarks,
        handovers: handovers || {},
        accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
        csvFormatRules: accountInfo.csv_format_rules,
        latestWi, oldStoreAmounts,
      });
    } else {
      sql = buildBulkResubmitTransactionSql_(
        parentInvoiceId, stagingId, summaryData, remarks,
        handovers || {},
        accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
        latestWi, oldStoreAmounts
      );
    }
    Logger.log('[BQ] bulk_resubmit SQL:\n' + sql);
    runTransactionSql_(projectId, sql);

    // staging DROP
    try {
      dropStagingTable_(projectId, datasetId, stagingId);
    } catch (dropErr) {
      logError_('Invoice', 'bulkResubmitInvoiceData staging DROP 失敗（手動削除が必要）', dropErr);
    }

    logInfo_('Invoice', 'bulkResubmitInvoiceData 完了: parentInvoiceId=' + parentInvoiceId);
    return success_({ csv_url: csvUrl });
  } catch (err) {
    logError_('Invoice', 'bulkResubmitInvoiceData', err);
    throw err;
  }
}

/**
 * Drive フォルダ構造: DRIVE_ROOT / wholesaler_id_wholesaler_name / YYYYMM / タイムスタンプ_original.csv
 *
 * フロー:
 *   ① Drive に CSV を保存（元ファイル保全）
 *   ② ヘッダー検証 + 税額 ±1円バリデーション（validateTaxAdjustment_）
 *   ③ 生CSV を BQ Load Job で staging テーブルへ投入
 *   ④ Load Job 完了待ち（ポーリング）
 *   ⑤ BEGIN TRANSACTION で子・孫・親を一括 INSERT → COMMIT
 *   ⑥ staging テーブルを DROP（TRANSACTION 外）
 *
 * 【セキュリティ】
 *   - wholesaler_id / wholesaler_user_id / mall_code はサーバー側で取得（改ざん防止）
 *   - summaryData.customerCode が merchant_mappings に存在するかをサーバー側で検証
 *   - 金額・備考はフロント確定値をそのまま使用（卸が確認画面で承認した値）
 *   - 税額（tax10/tax8）は CSV テキストから GAS 上で再集計し、
 *     summaryData との差異が ±1円を超える場合はエラーにする（validateTaxAdjustment_）
 *
 * 【TODO: 本番実装時の宿題】
 *   本番（Kotlin+React+Postgres）移行時は、DB 側で明細を再集計して
 *   summaryData との突合を行う設計に切り替えること。
 *   POC（GAS+BQ）では GAS 上で CSV をパースして検証する方式で実装している。
 *
 * @param {string} rawCsvBase64  - 元CSVのBase64（元ファイルのバイト列そのまま。Drive保存に使用）
 * @param {string} utf8CsvBase64 - UTF-8変換済みCSVのBase64（ヘッダー検証・BQ Load Jobに使用）
 * @param {Object} summaryData - フロント確定値 { wholesalerTotal: {...}, merchantTotals: [...] }
 * @param {Object} remarks     - 加盟店別備考 { [customerCode]: string }
 * @returns {{ status: 'success', data: { csv_url: string, invoice_uuid: string } }}
 * @throws {Error} Drive 操作または BQ 書き込み失敗時
 */
function sendInvoiceData(rawCsvBase64, utf8CsvBase64, summaryData, remarks) {
  const totalStart = Date.now();
  try {
    // ── サーバー側から卸情報を取得（改ざん不可）──────────────────────────
    const accountInfo = getServerAccountInfo_();
    logInfo_('Invoice', 'sendInvoiceData 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', merchantTotals_count=' + (summaryData && summaryData.merchantTotals ? summaryData.merchantTotals.length : 0));
    const mappings    = accountInfo.merchant_mappings || [];

    // ── 入力バリデーション ────────────────────────────────────────────────
    if (!rawCsvBase64)  throw new Error('CSVデータの送信に失敗しました。ファイルを再度選択してアップロードしてください。');
    if (!utf8CsvBase64) throw new Error('CSVデータの送信に失敗しました。ファイルを再度選択してアップロードしてください。');
    if (!summaryData || !summaryData.wholesalerTotal || !Array.isArray(summaryData.merchantTotals)) {
      throw new Error('送信データに不備があります。ページを再読み込みして再度お試しください。');
    }
    if (!remarks || typeof remarks !== 'object') {
      throw new Error('送信データに不備があります。ページを再読み込みして再度お試しください。');
    }
    if (summaryData.merchantTotals.length === 0) {
      throw new Error('送信対象の加盟店データがありません。CSVを確認してください。');
    }

    // ── 請求書受付期間（WHOLESALER_INVOICE_STORAGE）チェック ────────────────
    const storageEndDate = fetchWholesalerInvoiceStorageEndDate_(accountInfo.wholesaler_id);
    if (storageEndDate) {
      const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
      if (today > String(storageEndDate.end_at).slice(0, 10)) {
        throw new Error('請求書受付期間を過ぎているため、アップロードできません。');
      }
    }

    // ── 当月重複チェック（同一卸が当月に既に新規請求書を登録済みかチェック）──
    if (hasCurrentMonthInvoice_(accountInfo.wholesaler_id)) {
      throw new Error('今月は既に新規の請求書が登録されています。差し戻しや否認の修正版のアップロードは詳細画面からアップロードしてください。');
    }

    // ── csv_format_rules から staging スキーマを生成 ────────────────────────
    // null（デフォルト卸）→ loadCsvToBq_ が STAGING_SCHEMA_（固定9列・名前付きカラム）を使用
    // 新形式（columns 配列）→ loadCsvToBq_ が string_field_0〜N の全列 STRING 明示スキーマを使用
    //   autodetect: true は使用しない（BQ が DATE/INT64 等に推論すると後段 SQL が型不一致で失敗するため）
    const stagingSchema = buildStagingSchema_(accountInfo.csv_format_rules);

    // ── merchant_mappings で customerCode を検証し mall_code マップを構築 ──
    const mallCodeMap = buildMallCodeMap_(mappings, summaryData.merchantTotals);

    // ── ② ヘッダー検証（utf8CsvBase64 を使用。データ行は読まない）──────────
    const utf8Bytes = Utilities.base64Decode(utf8CsvBase64);
    const csvText   = Utilities.newBlob(utf8Bytes, MimeType.CSV).getDataAsString('UTF-8');
    // csv_format_rules の形式によりヘッダー検証関数を切り替える。
    //   新形式（columns 配列）: be_csv_mapper.js の validateCsvHeaderByRules_() を使用
    //   null（デフォルト卸）  : 固定9列の validateCsvHeader_() を使用
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      validateCsvHeaderByRules_(csvText, accountInfo.csv_format_rules); // be_csv_mapper.js
    } else {
      validateCsvHeader_(csvText, getExpectedHeaders_());
    }
    Logger.log('[CSV] ヘッダー検証完了');

    // ── 税額 ±1円バリデーション ────────────────────────────────────────────
    validateTaxAdjustment_(csvText, summaryData, accountInfo.csv_format_rules, accountInfo.tax_rounding_method || 'floor');

    // ── UUID 生成（全テーブルの結合キー）──────────────────────────────────
    const invoiceUuid = Utilities.getUuid();
    // ⚠️ BQ テーブル名はハイフン不可 → アンダースコアに変換すること
    const stagingId   = 'staging_invoice_lines_' + invoiceUuid.replace(/-/g, '_');

    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const location  = config.bqLocation;
    const now       = new Date();

    // ── ① Drive 保存（rawCsvBase64: 元ファイルのバイト列をそのまま保存）──────
    const driveStart = Date.now();
    const rawBytes    = Utilities.base64Decode(rawCsvBase64);
    const rootFolder  = DriveApp.getFolderById(config.driveFolderId);
    const folderName  = accountInfo.wholesaler_id + '_' + accountInfo.wholesaler_name;
    const userFolder  = getOrCreateSubFolder_(rootFolder, folderName);
    const monthFolder = getOrCreateSubFolder_(userFolder, formatYearMonth_(now));
    const fileName    = formatTimestamp_(now) + '_original.csv';
    const saveBlob    = Utilities.newBlob(rawBytes, MimeType.CSV, fileName);
    const csvFile     = monthFolder.createFile(saveBlob);
    const csvUrl      = csvFile.getUrl();
    logInfo_('Invoice', 'sendInvoiceData Drive保存完了: ' + (Date.now() - driveStart) + 'ms, url=' + csvUrl);

    // ── ③ 生CSV を BQ Load Job で staging テーブルへ投入（utf8Bytes を使用）──
    const loadJobStart = Date.now();
    logInfo_('Invoice', 'sendInvoiceData Load Job 投入: stagingId=' + stagingId);
    const jobId = loadCsvToBq_(projectId, datasetId, stagingId, utf8Bytes, stagingSchema, location);

    // ── ⑤ Load Job 完了待ち（ポーリング）────────────────────────
    waitForLoadJob_(projectId, jobId, location);
    logInfo_('Invoice', 'sendInvoiceData Load Job完了: ' + (Date.now() - loadJobStart) + 'ms');

    // ── ⑤ BEGIN TRANSACTION で子・孫・親を一括 INSERT ───────────────────
    // csv_format_rules の形式により SQL 組み立て関数を切り替える。
    //   新形式（columns 配列）: be_csv_mapper.js の buildMappedTransactionSql_() を使用
    //   null（デフォルト卸）  : 固定9列前提の buildTransactionSql_() を使用
    let sql;
    if (isNewFormatRules_(accountInfo.csv_format_rules)) {
      sql = buildMappedTransactionSql_({                // be_csv_mapper.js
        invoiceUuid, stagingId, summaryData, remarks,
        accountInfo, mallCodeMap, csvUrl, projectId, datasetId,
        csvFormatRules: accountInfo.csv_format_rules,
      });
    } else {
      sql = buildTransactionSql_(
        invoiceUuid, stagingId, summaryData, remarks,
        accountInfo, mallCodeMap, csvUrl, projectId, datasetId
      );
    }
    const txStart = Date.now();
    logInfo_('Invoice', 'sendInvoiceData トランザクション SQL 実行: invoiceUuid=' + invoiceUuid);
    Logger.log('[BQ] SQL全文:\n' + sql);
    runTransactionSql_(projectId, sql);
    logInfo_('Invoice', 'sendInvoiceData トランザクション完了: ' + (Date.now() - txStart) + 'ms');

    // ── ⑥ staging テーブルを DROP（TRANSACTION 外）─────────────────────
    // DROP 失敗はフロントにエラーを返さない（DB への登録は完了しているため）
    const dropStart = Date.now();
    try {
      dropStagingTable_(projectId, datasetId, stagingId);
      logInfo_('Invoice', 'sendInvoiceData staging DROP完了: ' + (Date.now() - dropStart) + 'ms');
    } catch (dropErr) {
      logError_('Invoice', 'sendInvoiceData staging DROP 失敗（手動削除が必要）', dropErr);
    }

    logInfo_('Invoice', 'sendInvoiceData 完了: invoiceUuid=' + invoiceUuid + ', total=' + (Date.now() - totalStart) + 'ms');
    return success_({ csv_url: csvUrl, invoice_uuid: invoiceUuid });
  } catch (err) {
    logError_('Invoice', 'sendInvoiceData', err);
    throw err;
  }
}

// =============================================================================
// 変更なしで再請求（ステータス更新のみ）
// =============================================================================

/**
 * 変更なしで再請求する。CSV の再アップロードは不要。
 * store_invoices の backoffice_review_status を PENDING_REVIEW に更新し、
 * 否認の場合は wholesaler_handover を更新する。
 * invoice_status（DISPUTED等）はそのまま維持する。
 *
 * @param {string}      storeInvoiceId     - 対象の store_invoices.id
 * @param {string}      parentInvoiceId    - 大元の wholesaler_invoices.id
 * @param {string|null} wholesalerHandover - 否認時の加盟店との合意内容（差し戻しの場合はnull）
 * @returns {{ status: 'success', data: Object }}
 */
function resubmitWithoutChanges(storeInvoiceId, parentInvoiceId, wholesalerHandover) {
  try {
    const accountInfo  = getServerAccountInfo_();
    logInfo_('Invoice', 'resubmitWithoutChanges 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', storeInvoiceId=' + storeInvoiceId + ', parentInvoiceId=' + parentInvoiceId);
    const wholesalerId = accountInfo.wholesaler_id;

    if (!storeInvoiceId)  throw new Error('storeInvoiceId が指定されていません');
    if (!parentInvoiceId) throw new Error('parentInvoiceId が指定されていません');

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(storeInvoiceId))  throw new Error('storeInvoiceId の形式が不正です: ' + storeInvoiceId);
    if (!UUID_RE.test(parentInvoiceId)) throw new Error('parentInvoiceId の形式が不正です: ' + parentInvoiceId);

    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const storeRef  = '`' + projectId + '.' + datasetId + '.store_invoices`';
    const invRef    = '`' + projectId + '.' + datasetId + '.wholesaler_invoices`';

    const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

    // wholesaler_handover の更新:
    //   - 値が渡された場合（否認で入力あり）→ その値で更新
    //   - null/空の場合（差し戻し等）→ 既存値を維持
    let handoverSetClause;
    if (wholesalerHandover != null && wholesalerHandover !== '') {
      handoverSetClause = "wholesaler_handover = '" + esc(wholesalerHandover) + "'";
    } else {
      handoverSetClause = 'wholesaler_handover = wholesaler_handover';
    }

    const sql =
      'UPDATE ' + storeRef + ' ' +
      "SET backoffice_review_status = 'PENDING_REVIEW', " +
      handoverSetClause + ' ' +
      "WHERE id = '" + storeInvoiceId + "' " +
      "  AND wholesaler_invoice_id IN (SELECT id FROM " + invRef + " WHERE id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "') " +
      '  AND wholesaler_id = ' + Number(wholesalerId) + ' ' +
      '  AND is_latest = TRUE ' +
      "  AND (backoffice_review_status = 'RETURNED' OR (backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED' AND invoice_status = 'DISPUTED'))";

    Logger.log('[BQ] resubmitWithoutChanges SQL: ' + sql);
    runTransactionSql_(projectId, sql);

    logInfo_('Invoice', 'resubmitWithoutChanges 完了: storeInvoiceId=' + storeInvoiceId);
    return success_({ store_invoice_id: storeInvoiceId });
  } catch (err) {
    logError_('Invoice', 'resubmitWithoutChanges', err);
    throw err;
  }
}


// =============================================================================
// 請求取り下げ
// =============================================================================

/**
 * 対象の store_invoices.invoice_status を WITHDRAWN に更新し、
 * wholesaler_invoices の金額を再計算した新版を INSERT する。
 *
 * @param {string} storeInvoiceId  - 対象の store_invoices.id
 * @param {string} parentInvoiceId - 大元の wholesaler_invoices.id（IDOR対策）
 * @returns {{ status: 'success', data: Object } | { status: 'error', message: string }}
 */
function withdrawStoreInvoice(storeInvoiceId, parentInvoiceId) {
  try {
    const accountInfo  = getServerAccountInfo_();
    logInfo_('Invoice', 'withdrawStoreInvoice 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', storeInvoiceId=' + storeInvoiceId + ', parentInvoiceId=' + parentInvoiceId);
    const wholesalerId = accountInfo.wholesaler_id;

    if (!storeInvoiceId)  throw new Error('対象の加盟店請求情報の取得に失敗しました。ページを再読み込みしてください。');
    if (!parentInvoiceId) throw new Error('請求情報の取得に失敗しました。ページを再読み込みしてください。');

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(storeInvoiceId))  throw new Error('対象の加盟店請求情報の取得に失敗しました。ページを再読み込みしてください。');
    if (!UUID_RE.test(parentInvoiceId)) throw new Error('請求情報の取得に失敗しました。ページを再読み込みしてください。');

    // ── 事前バリデーション ──────────────────────────────────────────────────
    const storeRow = fetchStoreInvoiceForWithdraw_(storeInvoiceId, parentInvoiceId, wholesalerId, 'DISPUTED');
    if (!storeRow) {
      logInfo_('Invoice', 'withdrawStoreInvoice: 対象が見つかりませんでした storeInvoiceId=' + storeInvoiceId);
      return error_('対象の請求が見つからないか、既にステータスが変更されています。ページを再読み込みしてください。');
    }

    const latestWi = fetchLatestWholesalerInvoice_(parentInvoiceId, wholesalerId);
    if (!latestWi) {
      logInfo_('Invoice', 'withdrawStoreInvoice: 最新 WI が見つかりませんでした parentInvoiceId=' + parentInvoiceId);
      return error_('請求情報が見つかりませんでした。ページを再読み込みしてください。');
    }

    // ── トランザクション SQL 組み立て ───────────────────────────────────────
    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const storeRef  = '`' + projectId + '.' + datasetId + '.store_invoices`';
    const wiRef     = '`' + projectId + '.' + datasetId + '.wholesaler_invoices`';

    const sql = [
      'BEGIN TRANSACTION;',
      '',
      '-- 1. store_invoices のステータスを WITHDRAWN に変更',
      'UPDATE ' + storeRef,
      "SET invoice_status = 'WITHDRAWN'",
      "WHERE id = '" + storeInvoiceId + "'",
      "  AND wholesaler_invoice_id IN (SELECT id FROM " + wiRef + " WHERE id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "')",
      '  AND wholesaler_id = ' + Number(wholesalerId),
      '  AND is_latest = TRUE',
      "  AND invoice_status = 'DISPUTED';",
      '',
      '-- @@row_count 検証: UPDATE が 0 行なら並行更新と判断しロールバック',
      'IF @@row_count = 0 THEN',
      '  ROLLBACK TRANSACTION;',
      '  RAISE USING MESSAGE = \'他の操作と競合したため更新できませんでした。ページを再読み込みして再度お試しください。\';',
      'END IF;',
      '',
      '-- 2. wholesaler_invoices の新版を INSERT（金額 = 最新WI − 取下げstore）',
      'INSERT INTO ' + wiRef,
      '  (id, wholesaler_user_id, wholesaler_id, wholesaler_invoice_date,',
      '   wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
      '   wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount,',
      '   wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount,',
      '   wholesaler_non_taxable_amount,',
      '   wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
      '   handover_matter, wholesaler_invoice_id, wholesaler_invoice_csv_url, created_at)',
      'SELECT',
      '  GENERATE_UUID(),',
      '  wi.wholesaler_user_id,',
      '  wi.wholesaler_id,',
      '  wi.wholesaler_invoice_date,',
      '  wi.wholesaler_total_amount           - si.total_amount,',
      '  wi.wholesaler_subtotal_amount        - si.subtotal_amount,',
      '  wi.wholesaler_tax_amount             - si.tax_amount,',
      '  wi.wholesaler_standard_tax_target_amount - si.standard_tax_target_amount,',
      '  wi.wholesaler_standard_tax_amount    - si.standard_tax_amount,',
      '  wi.wholesaler_reduced_tax_target_amount  - si.reduced_tax_target_amount,',
      '  wi.wholesaler_reduced_tax_amount     - si.reduced_tax_amount,',
      '  wi.wholesaler_non_taxable_amount     - si.non_taxable_amount,',
      '  wi.wholesaler_fee_rate,',
      '  CAST(FLOOR(',
      '    (wi.wholesaler_total_amount - si.total_amount) * wi.wholesaler_fee_rate / 100',
      '  ) AS INT64),',
      '  (wi.wholesaler_total_amount - si.total_amount)',
      '    - CAST(FLOOR(',
      '        (wi.wholesaler_total_amount - si.total_amount) * wi.wholesaler_fee_rate / 100',
      '      ) AS INT64),',
      '  wi.handover_matter,',
      "  '" + parentInvoiceId + "',",
      '  wi.wholesaler_invoice_csv_url,',
      '  CURRENT_TIMESTAMP()',
      'FROM (',
      '  SELECT *',
      '  FROM ' + wiRef,
      "  WHERE (id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "')",
      '    AND wholesaler_id = ' + Number(wholesalerId),
      '  ORDER BY created_at DESC',
      '  LIMIT 1',
      ') AS wi',
      'CROSS JOIN ' + storeRef + ' AS si',
      "WHERE si.id = '" + storeInvoiceId + "'",
      '  AND si.is_latest = TRUE;',
      '',
      'COMMIT;',
    ].join('\n');

    Logger.log('[BQ] withdrawStoreInvoice SQL:\n' + sql);
    try {
      runTransactionSql_(projectId, sql);
    } catch (txErr) {
      // @@row_count = 0 による RAISE（並行更新）は業務エラーとして error_() を返す
      if (String(txErr.message || '').indexOf('他の操作と競合したため更新できませんでした') !== -1) {
        logInfo_('Invoice', 'withdrawStoreInvoice: 並行更新により UPDATE 0行 storeInvoiceId=' + storeInvoiceId);
        return error_('対象の請求が見つからないか、既にステータスが変更されています。ページを再読み込みしてください。');
      }
      throw txErr;
    }

    logInfo_('Invoice', 'withdrawStoreInvoice 完了: storeInvoiceId=' + storeInvoiceId);
    return success_({ store_invoice_id: storeInvoiceId });
  } catch (err) {
    logError_('Invoice', 'withdrawStoreInvoice', err);
    throw err;
  }
}

/**
 * 取下げを取り消す（invoice_status を WITHDRAWN → DISPUTED に戻す）。
 * wholesaler_invoices の金額を再計算した新版を INSERT する（戻す store 分を加算）。
 *
 * @param {string} storeInvoiceId  - 対象 store_invoices.id
 * @param {string} parentInvoiceId - 大元の wholesaler_invoices.id（IDOR対策）
 * @returns {{ status: 'success', data: Object } | { status: 'error', message: string }}
 */
function undoWithdrawStoreInvoice(storeInvoiceId, parentInvoiceId) {
  try {
    const accountInfo  = getServerAccountInfo_();
    logInfo_('Invoice', 'undoWithdrawStoreInvoice 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', storeInvoiceId=' + storeInvoiceId + ', parentInvoiceId=' + parentInvoiceId);
    const wholesalerId = accountInfo.wholesaler_id;

    if (!storeInvoiceId)  throw new Error('対象の加盟店請求情報の取得に失敗しました。ページを再読み込みしてください。');
    if (!parentInvoiceId) throw new Error('請求情報の取得に失敗しました。ページを再読み込みしてください。');

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(storeInvoiceId))  throw new Error('対象の加盟店請求情報の取得に失敗しました。ページを再読み込みしてください。');
    if (!UUID_RE.test(parentInvoiceId)) throw new Error('請求情報の取得に失敗しました。ページを再読み込みしてください。');

    // ── 事前バリデーション ──────────────────────────────────────────────────
    const storeRow = fetchStoreInvoiceForWithdraw_(storeInvoiceId, parentInvoiceId, wholesalerId, 'WITHDRAWN');
    if (!storeRow) {
      logInfo_('Invoice', 'undoWithdrawStoreInvoice: 対象が見つかりませんでした storeInvoiceId=' + storeInvoiceId);
      return error_('対象の請求が見つからないか、既にステータスが変更されています。ページを再読み込みしてください。');
    }

    const latestWi = fetchLatestWholesalerInvoice_(parentInvoiceId, wholesalerId);
    if (!latestWi) {
      logInfo_('Invoice', 'undoWithdrawStoreInvoice: 最新 WI が見つかりませんでした parentInvoiceId=' + parentInvoiceId);
      return error_('請求情報が見つかりませんでした。ページを再読み込みしてください。');
    }

    // ── OBJECTION_PERIOD チェック ──────────────────────────────────────────
    const periodRow = fetchObjectionPeriodEndDate_(wholesalerId, latestWi.wholesaler_invoice_date);
    if (periodRow && periodRow.end_at) {
      const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
      if (String(periodRow.end_at) < today) {
        logInfo_('Invoice', 'undoWithdrawStoreInvoice: 異議申立期間終了 end_at=' + periodRow.end_at + ', today=' + today);
        return error_('異議申立期間が終了しているため、取下げの取り消しはできません。');
      }
    }

    // ── トランザクション SQL 組み立て ───────────────────────────────────────
    const config    = getConfig_();
    const projectId = config.gcpProjectId;
    const datasetId = config.bqDatasetId;
    const storeRef  = '`' + projectId + '.' + datasetId + '.store_invoices`';
    const wiRef     = '`' + projectId + '.' + datasetId + '.wholesaler_invoices`';

    const sql = [
      'BEGIN TRANSACTION;',
      '',
      '-- 1. store_invoices のステータスを DISPUTED に戻す',
      'UPDATE ' + storeRef,
      "SET invoice_status = 'DISPUTED'",
      "WHERE id = '" + storeInvoiceId + "'",
      "  AND wholesaler_invoice_id IN (SELECT id FROM " + wiRef + " WHERE id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "')",
      '  AND wholesaler_id = ' + Number(wholesalerId),
      '  AND is_latest = TRUE',
      "  AND invoice_status = 'WITHDRAWN';",
      '',
      '-- @@row_count 検証: UPDATE が 0 行なら並行更新と判断しロールバック',
      'IF @@row_count = 0 THEN',
      '  ROLLBACK TRANSACTION;',
      '  RAISE USING MESSAGE = \'他の操作と競合したため更新できませんでした。ページを再読み込みして再度お試しください。\';',
      'END IF;',
      '',
      '-- 2. wholesaler_invoices の新版を INSERT（金額 = 最新WI + 戻すstore）',
      'INSERT INTO ' + wiRef,
      '  (id, wholesaler_user_id, wholesaler_id, wholesaler_invoice_date,',
      '   wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount,',
      '   wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount,',
      '   wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount,',
      '   wholesaler_non_taxable_amount,',
      '   wholesaler_fee_rate, invoice_fee_amount, payment_amount,',
      '   handover_matter, wholesaler_invoice_id, wholesaler_invoice_csv_url, created_at)',
      'SELECT',
      '  GENERATE_UUID(),',
      '  wi.wholesaler_user_id,',
      '  wi.wholesaler_id,',
      '  wi.wholesaler_invoice_date,',
      '  wi.wholesaler_total_amount           + si.total_amount,',
      '  wi.wholesaler_subtotal_amount        + si.subtotal_amount,',
      '  wi.wholesaler_tax_amount             + si.tax_amount,',
      '  wi.wholesaler_standard_tax_target_amount + si.standard_tax_target_amount,',
      '  wi.wholesaler_standard_tax_amount    + si.standard_tax_amount,',
      '  wi.wholesaler_reduced_tax_target_amount  + si.reduced_tax_target_amount,',
      '  wi.wholesaler_reduced_tax_amount     + si.reduced_tax_amount,',
      '  wi.wholesaler_non_taxable_amount     + si.non_taxable_amount,',
      '  wi.wholesaler_fee_rate,',
      '  CAST(FLOOR(',
      '    (wi.wholesaler_total_amount + si.total_amount) * wi.wholesaler_fee_rate / 100',
      '  ) AS INT64),',
      '  (wi.wholesaler_total_amount + si.total_amount)',
      '    - CAST(FLOOR(',
      '        (wi.wholesaler_total_amount + si.total_amount) * wi.wholesaler_fee_rate / 100',
      '      ) AS INT64),',
      '  wi.handover_matter,',
      "  '" + parentInvoiceId + "',",
      '  wi.wholesaler_invoice_csv_url,',
      '  CURRENT_TIMESTAMP()',
      'FROM (',
      '  SELECT *',
      '  FROM ' + wiRef,
      "  WHERE (id = '" + parentInvoiceId + "' OR wholesaler_invoice_id = '" + parentInvoiceId + "')",
      '    AND wholesaler_id = ' + Number(wholesalerId),
      '  ORDER BY created_at DESC',
      '  LIMIT 1',
      ') AS wi',
      'CROSS JOIN ' + storeRef + ' AS si',
      "WHERE si.id = '" + storeInvoiceId + "'",
      '  AND si.is_latest = TRUE;',
      '',
      'COMMIT;',
    ].join('\n');

    Logger.log('[BQ] undoWithdrawStoreInvoice SQL:\n' + sql);
    try {
      runTransactionSql_(projectId, sql);
    } catch (txErr) {
      // @@row_count = 0 による RAISE（並行更新）は業務エラーとして error_() を返す
      if (String(txErr.message || '').indexOf('他の操作と競合したため更新できませんでした') !== -1) {
        logInfo_('Invoice', 'undoWithdrawStoreInvoice: 並行更新により UPDATE 0行 storeInvoiceId=' + storeInvoiceId);
        return error_('対象の請求が見つからないか、既にステータスが変更されています。ページを再読み込みしてください。');
      }
      throw txErr;
    }

    logInfo_('Invoice', 'undoWithdrawStoreInvoice 完了: storeInvoiceId=' + storeInvoiceId);
    return success_({ store_invoice_id: storeInvoiceId });
  } catch (err) {
    logError_('Invoice', 'undoWithdrawStoreInvoice', err);
    throw err;
  }
}


// =============================================================================
// 請求一覧取得
// =============================================================================

/**
 * ログインユーザーの請求一覧を BQ から取得して返す。
 * wholesaler_id はサーバー側で getServerAccountInfo_() から取得する（引数は無視）。
 * フロントから渡された引数を使わないことで sessionStorage 改ざんによる他卸データ取得を防ぐ。
 *
 * @returns {{ status: 'success', data: Array<Object> }}
 */
function fetchInvoices() {
  try {
    const accountInfo  = getServerAccountInfo_();
    logInfo_('Invoice', 'fetchInvoices 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id);
    const wholesalerId = accountInfo.wholesaler_id;
    const result = fetchInvoicesByWholesaler_(wholesalerId);
    logInfo_('Invoice', 'fetchInvoices 完了: 取得件数=' + (result ? result.length : 0));
    return success_(result);
  } catch (err) {
    logError_('Invoice', 'fetchInvoices', err);
    throw err;
  }
}

// =============================================================================
// 請求詳細取得
// TODO: バックオフィスAPI実装後に fetchInvoiceDetail_() に差し替える
// =============================================================================

/**
 * 指定した請求IDの詳細データを返す。
 * 親サマリー（wholesaler_invoices 1行）と加盟店一覧（store_invoices）を一括取得する。
 * 孫明細（invoice_lines）はアコーディオン開閉時にオンデマンドで getInvoiceLinesByStore() を呼ぶ設計。
 *
 * @param {string} invoiceId - 取得対象の卸インボイスID
 * @returns {{ status: 'success', data: { summary: Object, stores: Array<Object> } | null }}
 */
function fetchInvoiceDetail(invoiceId) {
  try {
    if (!invoiceId) throw new Error('invoiceId が指定されていません');
    const accountInfo  = getServerAccountInfo_(); // ログインユーザーの権限検証
    logInfo_('Invoice', 'fetchInvoiceDetail 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', invoiceId=' + invoiceId);
    const wholesalerId = accountInfo.wholesaler_id;
    const summary = fetchInvoiceDetailSummary_(invoiceId, wholesalerId);
    if (!summary) {
      logInfo_('Invoice', 'fetchInvoiceDetail: 該当なし invoiceId=' + invoiceId);
      return success_(null);
    }
    const stores = fetchStoreInvoicesByParent_(invoiceId, wholesalerId);
    logInfo_('Invoice', 'fetchInvoiceDetail 完了: stores_count=' + (stores ? stores.length : 0));
    return success_({ summary: summary, stores: stores });
  } catch (err) {
    logError_('Invoice', 'fetchInvoiceDetail', err);
    throw err;
  }
}

/**
 * 加盟店インボイスIDに紐づく明細（孫レコード）を最大1000件返す。
 * 詳細画面のアコーディオンがクリックされたタイミングでオンデマンドに呼ばれる。
 *
 * @param {string} storeInvoiceId - 加盟店インボイスID（store_invoices.id）
 * @returns {{ status: 'success', data: Array<Object> }}
 */
function getInvoiceLinesByStore(storeInvoiceId) {
  try {
    if (!storeInvoiceId) throw new Error('storeInvoiceId が指定されていません');
    const accountInfo  = getServerAccountInfo_(); // ログインユーザーの権限検証
    logInfo_('Invoice', 'getInvoiceLinesByStore 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id + ', storeInvoiceId=' + storeInvoiceId);
    const wholesalerId = accountInfo.wholesaler_id;
    const result = fetchInvoiceLinesByStore_(storeInvoiceId, wholesalerId);
    logInfo_('Invoice', 'getInvoiceLinesByStore 完了: 取得件数=' + (result ? result.length : 0));
    return success_(result);
  } catch (err) {
    logError_('Invoice', 'getInvoiceLinesByStore', err);
    throw err;
  }
}

// =============================================================================
// スケジュール取得（business_calendar）
// =============================================================================

/**
 * business_calendar テーブルからスケジュールデータを取得する。
 * サーバー側で wholesaler_id を確定するため、フロントからの引数は不要。
 * @returns {{ status: 'success', data: Array }}
 */
function fetchScheduleData() {
  try {
    const accountInfo  = getServerAccountInfo_();
    logInfo_('Invoice', 'fetchScheduleData 開始: wholesaler_id=' + accountInfo.wholesaler_id + ', account_id=' + accountInfo.wholesaler_user_id);
    const wholesalerId = accountInfo.wholesaler_id;
    const rows = fetchBusinessCalendar_(wholesalerId);
    logInfo_('Invoice', 'fetchScheduleData 完了: 取得件数=' + (rows ? rows.length : 0));
    return success_(rows || []);
  } catch (err) {
    logError_('Invoice', 'fetchScheduleData', err);
    throw err;
  }
}

// =============================================================================
// テスト用関数  ── 動作確認が終わったら削除してOK
// =============================================================================

/**
 * sendInvoiceData の動作確認用。
 * Script Property "ENV" が "development" のときのみ実行可能。
 *
 * ※ STUB_ACCOUNT_INFO_MODE=true かつ CSV の customer_code が "C001" であること。
 */
function testSendInvoice_() {
  const env = PropertiesService.getScriptProperties().getProperty('ENV');
  if (env !== 'development') {
    throw new Error('testSendInvoice_() は development 環境でのみ実行できます (ENV=' + env + ')');
  }

  // デフォルトCSVフォーマット（9列）に合わせたサンプルCSV（UTF-8）
  // 列順: 顧客コード,日付,品目,数量,単価,税率区分(%),請求金額（税抜）,消費税,備考
  const headers = '顧客コード,日付,品目,数量,単価,税率区分(%),請求金額（税抜）,消費税,備考';
  const dataRow = 'C001,2026-05-01,テスト品目,1,1000,10,1000,100,テスト備考';
  const dummyCsv = headers + '\r\n' + dataRow + '\r\n';
  // rawCsvBase64: Drive 保存用（元バイト列そのまま）
  // utf8CsvBase64: BQ Load Job / ヘッダー検証用（UTF-8 変換済み）
  // ※ テスト用サンプルは元から UTF-8 のため両者は同値
  const dummyRawBase64  = Utilities.base64Encode(dummyCsv);
  const dummyUtf8Base64 = Utilities.base64Encode(dummyCsv);

  // フロントから渡される summaryData / remarks のダミー
  const summaryData = {
    wholesalerTotal: {
      totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
      exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0,
      feeAmount: 55, paymentAmount: 1045,
    },
    merchantTotals: [
      { customerCode: 'C001', totalAmount: 1100, subtotalAmount: 1000, taxAmount: 100,
        exTax10: 1000, tax10: 100, exTax8: 0, tax8: 0 },
    ],
  };
  const remarks = { 'C001': 'テスト備考（手動入力）' };

  const result = sendInvoiceData(dummyRawBase64, dummyUtf8Base64, summaryData, remarks);
  Logger.log('テスト結果: ' + JSON.stringify(result));
}
