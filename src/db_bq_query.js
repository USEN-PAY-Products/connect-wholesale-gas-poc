// =============================================================================
// db_bq_query.js
//
// BigQuery からのデータ取得クエリロジックを管理するファイル。
//
// 依存: be_config.js（getConfig_）
//
// 公開する内部関数（末尾アンダースコア）:
//   fetchAccountInfoByWholesalerId_(wholesalerId, operatorEmail) … 卸ID+操作者メールからアカウント情報を取得
//   ensureOperatorWholesalerUser_(wholesalerId, operatorEmail)   … 操作者の wholesaler_user を確認/自動登録
//   fetchWholesalerList_()                                       … 卸一覧（active/end）を取得
//   fetchInvoicesByWholesaler_(wholesalerId)                     … 卸IDに紐づく請求一覧を取得
//   fetchInvoiceDetail_(invoiceId)                               … 請求IDに紐づく明細を取得
//   fetchBusinessCalendar_(wholesalerId)                         … 卸IDに紐づくスケジュールを取得
//   runQuery_(projectId, sql, params)                            … 汎用クエリ実行ラッパー
// =============================================================================

/**
 * 卸IDからアカウント情報を BQ から取得して集約されたオブジェクトを返す。
 * 卸（wholesalers）起点で JOIN し、操作者の wholesaler_user は別クエリで解決する。
 * 処理順:
 *   1. wholesalers + wholesaler_merchants + store を取得（0行 → null）
 *   2. wholesaler_status が active/end 以外 → WHOLESALER_INACTIVE を throw
 *   3. ensureOperatorWholesalerUser_ で操作者の wholesaler_user を確認/自動登録
 *
 * @param {number} wholesalerId  - 卸ID（数値）
 * @param {string} operatorEmail - 操作者のメールアドレス
 * @returns {Object|null} アカウント情報オブジェクト。卸が存在しない場合は null。
 * @throws {Error} WHOLESALER_INACTIVE: / クエリ失敗時
 */
function fetchAccountInfoByWholesalerId_(wholesalerId, operatorEmail) {
  const config = getConfig_();
  const p = config.gcpProjectId + '.' + config.bqDatasetId;

  // ── ① 卸 + 加盟店マッピング取得 ─────────────────────────────────────────
  // wholesaler_status は WHERE から外してアプリ側で判定する（INACTIVE の理由を区別するため）
  const sql =
    'WITH ws AS ( ' +
    '  SELECT id, wholesaler_name, wholesaler_status, wholesaler_fee_rate, ' +
    '         tax_rounding_method, csv_format_rules ' +
    '  FROM `' + p + '.wholesalers` ' +
    '  WHERE id = @wholesaler_id ' +
    '), ' +
    'latest_merchants AS ( ' +
    // registration_at が同一の場合の非決定性を避けるため、id の降順もタイブレークに含める
    '  SELECT customer_code, mall_code, wholesaler_id, ' +
    '    ROW_NUMBER() OVER (PARTITION BY mall_code, wholesaler_id ' +
    '                       ORDER BY registration_at DESC, id DESC) AS rn ' +
    '  FROM `' + p + '.wholesaler_merchants` ' +
    '  WHERE deleted_at IS NULL AND wholesaler_id = @wholesaler_id ' +
    ') ' +
    'SELECT w.id AS wholesaler_id, w.wholesaler_name, w.wholesaler_status, ' +
    '       w.wholesaler_fee_rate AS fee_rate, w.tax_rounding_method, w.csv_format_rules, ' +
    '       wm.customer_code, wm.mall_code, s.store_name ' +
    'FROM ws AS w ' +
    'LEFT JOIN latest_merchants AS wm ON wm.rn = 1 ' +
    'LEFT JOIN `' + p + '.store` AS s ' +
    '  ON s.mall_code = wm.mall_code AND s.store_status = \'active\'';

  const params = [
    { name: 'wholesaler_id', parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  if (!rows || rows.length === 0) return null;

  const first = rows[0];

  // ── ② wholesaler_status 検証 ─────────────────────────────────────────────
  const status = first.wholesaler_status;
  if (status !== 'active' && status !== 'end') {
    throw new Error('WHOLESALER_INACTIVE: この卸は現在利用できません（status=' + status + '）。');
  }

  // ── ③ 操作者の wholesaler_user を確認/自動登録 ───────────────────────────
  const wsUserId = ensureOperatorWholesalerUser_(wholesalerId, operatorEmail);

  // ── ④ merchant_mappings を組み立て（store_name が null → 除外）───────────
  const merchantMappings = rows
    .filter(function(r) { return r.mall_code && r.store_name; })
    .map(function(r) {
      return { customer_code: r.customer_code, mall_code: r.mall_code, store_name: r.store_name };
    });

  return {
    wholesaler_id:       Number(first.wholesaler_id),
    wholesaler_user_id:  wsUserId,
    wholesaler_name:     first.wholesaler_name,
    wholesaler_status:   first.wholesaler_status,
    fee_rate:            Number(first.fee_rate),
    tax_rounding_method: first.tax_rounding_method,
    csv_format_rules:    (function() {
      try {
        return first.csv_format_rules ? JSON.parse(first.csv_format_rules) : null;
      } catch (e) {
        Logger.log('[fetchAccountInfoByWholesalerId_] csv_format_rules のパースに失敗しました。デフォルトフォーマットを使用します: ' + e.message);
        return null;
      }
    })(),
    merchant_mappings:   merchantMappings,
  };
}

/**
 * 操作者の wholesaler_user 行を確認し、存在しない場合は自動登録する（D-3）。
 * 同時初回アクセスによる重複行を防ぐため LockService と再確認を組み合わせる。
 *
 * 処理フロー:
 *   1. active 行がある → そのまま id を返す（ロック不要・通常ケース）
 *   2. ロック取得 → ロック内で再確認
 *     a. active 行あり → その id を返す（他リクエストが先に登録済み）
 *     b. deleted 行のみあり → deleted_at を NULL に戻して復活
 *     c. 行なし → INSERT（Utilities.getUuid() で v4 UUID を生成）
 *
 * @param {number} wholesalerId  - 卸ID
 * @param {string} operatorEmail - 操作者のメールアドレス
 * @returns {string} wholesaler_user.id（UUID）
 * @throws {Error} SYSTEM: ロック取得失敗時
 */
function ensureOperatorWholesalerUser_(wholesalerId, operatorEmail) {
  const config = getConfig_();
  const p = config.gcpProjectId + '.' + config.bqDatasetId;

  // ── ① active 行の高速チェック（通常ケース・ロック不要）─────────────────
  const checkSql =
    'SELECT id, deleted_at ' +
    'FROM `' + p + '.wholesaler_user` ' +
    'WHERE wholesaler_id = @wholesaler_id AND wholesaler_email = @email ' +
    'ORDER BY (deleted_at IS NULL) DESC, registration_at DESC, id DESC ' +
    'LIMIT 1';
  const checkParams = [
    { name: 'wholesaler_id', parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
    { name: 'email',         parameterType: { type: 'STRING' }, parameterValue: { value: operatorEmail } },
  ];
  const checkRows = runQuery_(config.gcpProjectId, checkSql, checkParams);
  if (checkRows && checkRows.length > 0 && checkRows[0].deleted_at === null) {
    return checkRows[0].id;
  }

  // ── ② ロック取得（登録・復活処理を直列化）─────────────────────────────
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(30000)) {
      throw new Error('SYSTEM: 他の処理中のため登録できませんでした。再度お試しください。');
    }
  } catch (lockErr) {
    // tryLock 自体が例外を投げる場合（タイムアウト含む）
    const msg = String(lockErr.message || '');
    if (msg.startsWith('SYSTEM:')) throw lockErr;
    throw new Error('SYSTEM: 他の処理中のため登録できませんでした。再度お試しください。');
  }

  try {
    // ── ③ ロック内で再確認 ────────────────────────────────────────────────
    const innerRows = runQuery_(config.gcpProjectId, checkSql, checkParams);
    if (innerRows && innerRows.length > 0) {
      const row = innerRows[0];
      if (row.deleted_at === null) {
        // a. 他リクエストが先に登録済み
        return row.id;
      }
      // b. deleted 行のみ → 復活（deleted_at を NULL に）
      const updateSql =
        'UPDATE `' + p + '.wholesaler_user` ' +
        'SET deleted_at = NULL ' +
        'WHERE id = @id';
      runTransactionSql_(config.gcpProjectId, updateSql, [
        { name: 'id', parameterType: { type: 'STRING' }, parameterValue: { value: String(row.id) } },
      ]);
      return row.id;
    }

    // c. 行なし → INSERT
    const newId = Utilities.getUuid(); // v4 UUID（現行の卸システムの慣例）
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const insertSql =
      'INSERT INTO `' + p + '.wholesaler_user` ' +
      '(id, wholesaler_id, wholesaler_email, registration_at) ' +
      'VALUES (@id, @wholesaler_id, @email, @registration_at)';
    runTransactionSql_(config.gcpProjectId, insertSql, [
      { name: 'id', parameterType: { type: 'STRING' }, parameterValue: { value: newId } },
      { name: 'wholesaler_id', parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
      { name: 'email', parameterType: { type: 'STRING' }, parameterValue: { value: operatorEmail } },
      { name: 'registration_at', parameterType: { type: 'DATE' }, parameterValue: { value: today } },
    ]);
    logInfo_('Auth', 'ensureOperatorWholesalerUser_: 新規登録 wholesaler_id=' + wholesalerId + ', email=' + operatorEmail + ', id=' + newId);
    return newId;
  } finally {
    lock.releaseLock();
  }
}

/**
 * active / end ステータスの卸一覧を BQ から取得する。
 * ヘッダーの卸切替ドロップダウン用。
 *
 * @returns {Array<{wholesaler_id: number, wholesaler_name: string, wholesaler_status: string}>}
 * @throws {Error} クエリ失敗時
 */
function fetchWholesalerList_() {
  const config = getConfig_();
  const sql =
    'SELECT id AS wholesaler_id, wholesaler_name, wholesaler_status ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesalers` ' +
    "WHERE wholesaler_status IN ('active', 'end') " +
    'ORDER BY wholesaler_name, id';
  const rows = runQuery_(config.gcpProjectId, sql, []);
  return (rows || []).map(function(r) {
    return {
      wholesaler_id:     Number(r.wholesaler_id),
      wholesaler_name:   r.wholesaler_name,
      wholesaler_status: r.wholesaler_status,
    };
  });
}

/**
 * エラー通知用に卸名を ID から取得する（クライアント送信の名称は使用しない）。
 * @param {string} wholesalerId - 数字のみの卸ID
 * @returns {{wholesaler_id: number, wholesaler_name: string}|null}
 */
function fetchWholesalerNameById_(wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT id AS wholesaler_id, wholesaler_name ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesalers` ' +
    'WHERE id = @wholesaler_id LIMIT 1';
  const rows = runQuery_(config.gcpProjectId, sql, [
    { name: 'wholesaler_id', parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
  ]);
  if (!rows || rows.length === 0) return null;
  return {
    wholesaler_id: Number(rows[0].wholesaler_id),
    wholesaler_name: String(rows[0].wholesaler_name || ''),
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
  const tbl = '`' + config.gcpProjectId + '.' + config.bqDatasetId;
  const sql =
    'WITH ranked AS ( ' +
    '  SELECT *, ' +
    '    COALESCE(wholesaler_invoice_id, id) AS root_id, ' +
    '    ROW_NUMBER() OVER ( ' +
    '      PARTITION BY COALESCE(wholesaler_invoice_id, id) ' +
    '      ORDER BY created_at DESC ' +
    '    ) AS rn, ' +
    // 当月新規請求の重複判定用。再請求版ではなく系列の元の新規請求の作成日を保持する。
    '    MIN(IF(wholesaler_invoice_id IS NULL, created_at, NULL)) OVER (PARTITION BY COALESCE(wholesaler_invoice_id, id)) AS root_created_at ' +
    '  FROM ' + tbl + '.wholesaler_invoices` ' +
    '  WHERE wholesaler_id = @wholesaler_id ' +
    '), ' +
    'si_flags AS ( ' +
    '  SELECT ' +
    '    r.root_id, ' +
    '    MAX(CASE WHEN si.backoffice_review_status = \'RETURNED\' AND COALESCE(si.invoice_status, \'\') NOT IN (\'APPROVED\', \'WITHDRAWN\') THEN 1 ELSE 0 END) AS has_resubmit, ' +
    // 否認(DISPUTED)は要対応（MCR / RETURNED）の場合のみ「否認あり」として扱う。
    // WITHDRAW_REQUESTED（取り下げ依頼中）は取り下げ依頼中データのみの場合にTOPで否認ありと
    // 誤表示されないよう対象外とする（詳細画面の否認/差戻しセクション表示は変更しない）。
    // PENDING_REVIEW（再請求済み）は確認中・承認済み扱いのため対象外（詳細画面の disputed 判定と揃える）。
    '    MAX(CASE WHEN si.invoice_status = \'DISPUTED\' AND si.backoffice_review_status IN (\'MERCHANT_CONFIRMATION_REQUESTED\', \'RETURNED\') THEN 1 ELSE 0 END) AS has_denial ' +
    '  FROM ranked AS r ' +
    '  INNER JOIN ' + tbl + '.store_invoices` AS si ' +
    '    ON si.wholesaler_invoice_id = r.id ' +
    '    AND si.is_latest = TRUE ' +
    '    AND si.wholesaler_id = @wholesaler_id ' +
    '  GROUP BY r.root_id ' +
    ') ' +
    'SELECT ' +
    '  wi.id AS wholesaler_invoice_id, wi.root_id, wi.wholesaler_invoice_date, ' +
    '  FORMAT_TIMESTAMP(\'%Y/%m/%d\', wi.created_at, \'Asia/Tokyo\') AS created_at, ' +
    '  FORMAT_TIMESTAMP(\'%Y/%m/%d\', wi.root_created_at, \'Asia/Tokyo\') AS root_created_at, ' +
    '  wi.wholesaler_total_amount, wi.wholesaler_subtotal_amount, wi.wholesaler_tax_amount, ' +
    '  wi.wholesaler_standard_tax_target_amount, wi.wholesaler_standard_tax_amount, ' +
    '  wi.wholesaler_reduced_tax_target_amount, wi.wholesaler_reduced_tax_amount, ' +
    '  wi.wholesaler_non_taxable_amount, ' +
    '  wi.wholesaler_fee_rate, wi.invoice_fee_amount, wi.payment_amount, ' +
    '  COALESCE(sf.has_resubmit, 0) AS has_resubmit, ' +
    '  COALESCE(sf.has_denial, 0) AS has_denial ' +
    'FROM ranked AS wi ' +
    'LEFT JOIN si_flags AS sf ON sf.root_id = wi.root_id ' +
    'WHERE wi.rn = 1 ' +
    'ORDER BY wi.wholesaler_invoice_date DESC ' +
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
    '  wi.id, wi.wholesaler_invoice_date, ' +
    '  FORMAT_TIMESTAMP(\'%Y/%m/%d %H:%M:%S\', wi.created_at, \'Asia/Tokyo\') AS created_at, ' +
    '  wi.wholesaler_total_amount, wi.wholesaler_subtotal_amount, wi.wholesaler_tax_amount, ' +
    '  wi.wholesaler_standard_tax_target_amount, wi.wholesaler_standard_tax_amount, ' +
    '  wi.wholesaler_reduced_tax_target_amount, wi.wholesaler_reduced_tax_amount, ' +
    '  wi.wholesaler_non_taxable_amount, ' +
    '  wi.wholesaler_fee_rate, wi.invoice_fee_amount, wi.payment_amount, wi.handover_matter, ' +
    '  bc.end_at AS objection_end_at ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices` AS wi ' +
    'LEFT JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.business_calendar` AS bc ' +
    '  ON bc.wholesaler_id = wi.wholesaler_id ' +
    "  AND bc.event_type = 'OBJECTION_PERIOD' " +
    '  AND bc.year_month = DATE_TRUNC(wi.wholesaler_invoice_date, MONTH) ' +
    'WHERE (wi.id = @invoice_id OR wi.wholesaler_invoice_id = @invoice_id) ' +
    '  AND wi.wholesaler_id = @wholesaler_id ' +
    'ORDER BY wi.created_at DESC ' +
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
    'WITH latest_merchants AS ( ' +
    '  SELECT mall_code, customer_code, ' +
    // registration_at が同一の場合の非決定性を避けるため、id(UUID v7)の降順もタイブレークに含める
    '    ROW_NUMBER() OVER (PARTITION BY mall_code, wholesaler_id ORDER BY registration_at DESC, id DESC) AS rn ' +
    '  FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_merchants` ' +
    '  WHERE wholesaler_id = @wholesaler_id ' +
    '    AND deleted_at IS NULL ' +
    ') ' +
    'SELECT ' +
    '  si.id AS store_invoice_id, ' +
    '  si.mall_code, ' +
    '  s.store_name, ' +
    '  s.store_status, ' +
    '  si.wholesaler_managed_store_name, ' +
    '  lm.customer_code, ' +
    '  si.invoice_number, ' +
    '  si.invoice_number_id, ' +
    '  si.backoffice_review_status, ' +
    '  si.invoice_status, ' +
    '  si.total_amount, si.subtotal_amount, si.tax_amount, ' +
    '  si.standard_tax_target_amount, si.standard_tax_amount, ' +
    '  si.reduced_tax_target_amount, si.reduced_tax_amount, ' +
    '  si.non_taxable_amount, ' +
    '  si.backoffice_handover, si.wholesaler_handover, si.wholesaler_remark, si.backoffice_remark, ' +
    '  si.store_disputed_reason ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store_invoices` AS si ' +
    'LEFT JOIN `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store` AS s ' +
    '  ON s.mall_code = si.mall_code ' +
    'LEFT JOIN latest_merchants AS lm ' +
    '  ON lm.mall_code = si.mall_code AND lm.rn = 1 ' +
    'WHERE si.wholesaler_invoice_id IN (' +
    '  SELECT id FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices`' +
    '  WHERE id = @invoice_id OR wholesaler_invoice_id = @invoice_id' +
    ') ' +
    '  AND si.wholesaler_id = @wholesaler_id ' +
    '  AND si.is_latest = TRUE ' +
    'ORDER BY ' +
    '  CASE ' +
    '    WHEN si.backoffice_review_status = \'RETURNED\' THEN 0 ' +
    '    WHEN si.backoffice_review_status = \'MERCHANT_CONFIRMATION_REQUESTED\' AND si.invoice_status = \'DISPUTED\' THEN 1 ' +
    '    ELSE 2 ' +
    '  END ASC, ' +
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
 * 最新の wholesaler_invoices レコードを取得する（バージョン管理対応）。
 * 大元の id または wholesaler_invoice_id で紐づく全バージョンの中から、
 * created_at が最も新しいレコードを返す。
 *
 * @param {string} rootInvoiceId - 大元の wholesaler_invoices.id
 * @param {number} wholesalerId  - 卸業者ID
 * @returns {Object|null}
 */
function fetchLatestWholesalerInvoice_(rootInvoiceId, wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  id, wholesaler_invoice_date, ' +
    '  wholesaler_total_amount, wholesaler_subtotal_amount, wholesaler_tax_amount, ' +
    '  wholesaler_standard_tax_target_amount, wholesaler_standard_tax_amount, ' +
    '  wholesaler_reduced_tax_target_amount, wholesaler_reduced_tax_amount, ' +
    '  wholesaler_non_taxable_amount, ' +
    '  wholesaler_fee_rate, invoice_fee_amount, payment_amount ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices` ' +
    'WHERE (id = @invoice_id OR wholesaler_invoice_id = @invoice_id) ' +
    '  AND wholesaler_id = @wholesaler_id ' +
    'ORDER BY created_at DESC ' +
    'LIMIT 1';

  const params = [
    { name: 'invoice_id',    parameterType: { type: 'STRING' }, parameterValue: { value: String(rootInvoiceId) } },
    { name: 'wholesaler_id', parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 異議申立期間（OBJECTION_PERIOD）の end_at を取得する。
 * wholesaler_invoice_date から対象月を特定し、business_calendar から期間を取得する。
 *
 * @param {number} wholesalerId          - 卸業者ID
 * @param {string} wholesalerInvoiceDate - 請求日（DATE 文字列 例: '2026-05-22'）
 * @returns {Object|null} { end_at } を持つオブジェクト。見つからなければ null
 */
function fetchObjectionPeriodEndDate_(wholesalerId, wholesalerInvoiceDate) {
  const config = getConfig_();
  const sql =
    'SELECT end_at ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.business_calendar` ' +
    'WHERE wholesaler_id = @wholesaler_id ' +
    "  AND event_type = 'OBJECTION_PERIOD' " +
    '  AND year_month = DATE_TRUNC(@wholesaler_invoice_date, MONTH) ' +
    'LIMIT 1';

  const params = [
    { name: 'wholesaler_id',          parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
    { name: 'wholesaler_invoice_date', parameterType: { type: 'DATE'  }, parameterValue: { value: String(wholesalerInvoiceDate) } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 請求書受付期間（WHOLESALER_INVOICE_STORAGE）の end_at を取得する。
 * 当月の business_calendar から期間を取得する。
 *
 * @param {number} wholesalerId - 卸業者ID
 * @returns {Object|null} { end_at } を持つオブジェクト。見つからなければ null
 */
function fetchWholesalerInvoiceStorageEndDate_(wholesalerId) {
  const config = getConfig_();
  const today  = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const sql =
    'SELECT end_at ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.business_calendar` ' +
    'WHERE wholesaler_id = @wholesaler_id ' +
    "  AND event_type = 'WHOLESALER_INVOICE_STORAGE' " +
    '  AND year_month = DATE_TRUNC(@today, MONTH) ' +
    'LIMIT 1';

  const params = [
    { name: 'wholesaler_id', parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
    { name: 'today',         parameterType: { type: 'DATE'  }, parameterValue: { value: today } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 取り下げ依頼の取り消し時の事前バリデーション用。
 * 指定した store_invoices が存在し、backoffice_review_status が WITHDRAW_REQUESTED
 * （invoice_status は DISPUTED のまま）であることを確認する。
 *
 * @param {string} storeInvoiceId  - 対象の store_invoices.id
 * @param {string} parentInvoiceId - 大元の wholesaler_invoices.id
 * @param {number} wholesalerId    - 卸業者ID
 * @returns {Object|null} 該当行のオブジェクト。見つからなければ null
 */
function fetchStoreInvoiceForCancelWithdrawRequest_(storeInvoiceId, parentInvoiceId, wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT id, invoice_status, backoffice_review_status ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store_invoices` ' +
    'WHERE id = @store_invoice_id ' +
    '  AND wholesaler_invoice_id IN (' +
    '    SELECT id FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices`' +
    '    WHERE id = @invoice_id OR wholesaler_invoice_id = @invoice_id' +
    '  ) ' +
    '  AND wholesaler_id = @wholesaler_id ' +
    '  AND is_latest = TRUE ' +
    "  AND backoffice_review_status = 'WITHDRAW_REQUESTED' " +
    "  AND invoice_status = 'DISPUTED' " +
    'LIMIT 1';

  const params = [
    { name: 'store_invoice_id', parameterType: { type: 'STRING' }, parameterValue: { value: String(storeInvoiceId) } },
    { name: 'invoice_id',       parameterType: { type: 'STRING' }, parameterValue: { value: String(parentInvoiceId) } },
    { name: 'wholesaler_id',    parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 指定した store_invoices の金額を合算して返す。
 * 個別修正: storeInvoiceIds に対象1件を渡す
 * 一括修正: 要対応（RETURNED / DISPUTED）の全 store_invoices の金額を合算
 *
 * @param {string}        rootInvoiceId  - 大元の wholesaler_invoices.id
 * @param {number}        wholesalerId   - 卸業者ID
 * @param {string[]|null} storeInvoiceIds - 対象の store_invoices.id 配列（null の場合は全要対応を対象）
 * @returns {Object} 金額合計オブジェクト
 */
function fetchTargetStoreInvoiceAmounts_(rootInvoiceId, wholesalerId, storeInvoiceIds) {
  const config = getConfig_();
  let whereExtra;
  if (storeInvoiceIds && storeInvoiceIds.length > 0) {
    // 個別: 特定の store_invoices.id を対象
    const idList = storeInvoiceIds.map(function(id) { return "'" + String(id).replace(/'/g, "''") + "'"; }).join(',');
    whereExtra = '  AND si.id IN (' + idList + ') ';
  } else {
    // 一括: 要対応（RETURNED or DISPUTED）の全 store_invoices を対象
    whereExtra =
      '  AND si.is_latest = TRUE ' +
      '  AND (' +
      "    si.backoffice_review_status = 'RETURNED' " +
      "    OR (si.backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED' AND si.invoice_status = 'DISPUTED') " +
      '  ) ';
  }

  const sql =
    'SELECT ' +
    '  COALESCE(SUM(si.total_amount), 0) AS totalAmount, ' +
    '  COALESCE(SUM(si.subtotal_amount), 0) AS subtotalAmount, ' +
    '  COALESCE(SUM(si.tax_amount), 0) AS taxAmount, ' +
    '  COALESCE(SUM(si.standard_tax_target_amount), 0) AS exTax10, ' +
    '  COALESCE(SUM(si.standard_tax_amount), 0) AS tax10, ' +
    '  COALESCE(SUM(si.reduced_tax_target_amount), 0) AS exTax8, ' +
    '  COALESCE(SUM(si.reduced_tax_amount), 0) AS tax8 ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store_invoices` AS si ' +
    'WHERE si.wholesaler_invoice_id IN (' +
    '  SELECT id FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices`' +
    '  WHERE id = @invoice_id OR wholesaler_invoice_id = @invoice_id' +
    ') ' +
    '  AND si.wholesaler_id = @wholesaler_id ' +
    whereExtra;

  const params = [
    { name: 'invoice_id',    parameterType: { type: 'STRING' }, parameterValue: { value: String(rootInvoiceId) } },
    { name: 'wholesaler_id', parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  if (!rows || rows.length === 0) {
    return { totalAmount: 0, subtotalAmount: 0, taxAmount: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 };
  }
  const r = rows[0];
  return {
    totalAmount:    Number(r.totalAmount || 0),
    subtotalAmount: Number(r.subtotalAmount || 0),
    taxAmount:      Number(r.taxAmount || 0),
    exTax10:        Number(r.exTax10 || 0),
    tax10:          Number(r.tax10 || 0),
    exTax8:         Number(r.exTax8 || 0),
    tax8:           Number(r.tax8 || 0),
  };
}

/**
 * 一括再送信で対象となる要対応（RETURNED / DISPUTED）の mall_code 一覧を取得する。
 * 各 mall_code に対応する invoice_status も返却し、否認(DISPUTED)店舗の識別に使用する。
 *
 * @param {string} rootInvoiceId - wholesaler_invoices.id
 * @param {number} wholesalerId  - 卸ID
 * @returns {{ mall_code: string, invoice_status: string }[]} 要対応の mall_code と invoice_status の配列
 */
function fetchActionRequiredMallCodes_(rootInvoiceId, wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT DISTINCT si.mall_code, si.invoice_status ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store_invoices` AS si ' +
    'WHERE si.wholesaler_invoice_id IN (' +
    '  SELECT id FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices`' +
    '  WHERE id = @invoice_id OR wholesaler_invoice_id = @invoice_id' +
    ') ' +
    '  AND si.wholesaler_id = @wholesaler_id ' +
    '  AND si.is_latest = TRUE ' +
    '  AND (' +
    "    si.backoffice_review_status = 'RETURNED' " +
    "    OR (si.backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED' AND si.invoice_status = 'DISPUTED') " +
    '  )';
  const params = [
    { name: 'invoice_id',    parameterType: { type: 'STRING' }, parameterValue: { value: String(rootInvoiceId) } },
    { name: 'wholesaler_id', parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
  ];
  const rows = runQuery_(config.gcpProjectId, sql, params);
  return (rows || []).map(function (r) { return { mall_code: String(r.mall_code), invoice_status: String(r.invoice_status || '') }; });
}

/**
 * 指定された store_invoices.id の mall_code を取得する。
 *
 * @param {string} storeInvoiceId - store_invoices.id
 * @param {number} wholesalerId   - 卸ID
 * @returns {string|null} mall_code または null
 */
function fetchStoreInvoiceMallCode_(storeInvoiceId, wholesalerId, parentInvoiceId) {
  const config = getConfig_();
  const sql =
    'SELECT si.mall_code ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.store_invoices` AS si ' +
    'WHERE si.id = @store_invoice_id ' +
    '  AND si.wholesaler_id = @wholesaler_id ' +
    '  AND si.wholesaler_invoice_id IN (' +
    '    SELECT id FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices`' +
    '    WHERE id = @parent_invoice_id OR wholesaler_invoice_id = @parent_invoice_id' +
    '  ) ' +
    'LIMIT 1';
  const params = [
    { name: 'store_invoice_id', parameterType: { type: 'STRING' }, parameterValue: { value: String(storeInvoiceId) } },
    { name: 'wholesaler_id',    parameterType: { type: 'INT64'  }, parameterValue: { value: String(wholesalerId) } },
    { name: 'parent_invoice_id', parameterType: { type: 'STRING' }, parameterValue: { value: String(parentInvoiceId) } },
  ];
  const rows = runQuery_(config.gcpProjectId, sql, params);
  return (rows && rows.length > 0) ? String(rows[0].mall_code) : null;
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
  const queryStart = Date.now();
  // location はデータセットのリージョンと一致させる必要がある（BQ_LOCATION スクリプトプロパティで設定）。
  // 未指定だと getQueryResults がデフォルト US でジョブを探し「Not found: Job」になる。
  const location = getConfig_().bqLocation;
  const request = {
    query:           sql,
    useLegacySql:    false,
    timeoutMs:       10000, // 1回あたり10秒待機（jobComplete=false なら繰り返す）
    queryParameters: params || [],
    location:        location,
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
    response = BigQuery.Jobs.getQueryResults(projectId, jobId, { timeoutMs: 10000, location: location });
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
    const nextPage = BigQuery.Jobs.getQueryResults(projectId, jobId, { pageToken: pageToken, location: location });
    if (nextPage.errors && nextPage.errors.length > 0) {
      throw new Error('[BQ] ページング中エラー: ' + JSON.stringify(nextPage.errors));
    }
    allBqRows = allBqRows.concat(nextPage.rows || []);
    pageToken = nextPage.pageToken;
  }

  logInfo_('BQ', 'runQuery_ 完了: 取得行数=' + allBqRows.length + ', elapsed=' + (Date.now() - queryStart) + 'ms');

  // ── ④ rows を {カラム名: 値} のオブジェクト配列に変換 ────────────────────
  return allBqRows.map(function(row) {
    const obj = {};
    (row.f || []).forEach(function(cell, idx) {
      obj[schema[idx].name] = cell.v;
    });
    return obj;
  });
}
/**
 * 指定された卸業者が当月に既に請求書を登録しているかチェックする。
 * created_at が当月（Asia/Tokyo 基準）の範囲内にある wholesaler_invoices が存在すれば true。
 *
 * @param {number} wholesalerId - 卸業者ID
 * @returns {boolean} 当月に請求書が存在すれば true
 * @throws {Error} クエリ失敗時
 */
function hasCurrentMonthInvoice_(wholesalerId) {
  const config = getConfig_();
  const tbl = '`' + config.gcpProjectId + '.' + config.bqDatasetId + '.wholesaler_invoices`';
  const sql =
    'SELECT COUNT(*) AS cnt FROM ' + tbl + ' ' +
    'WHERE wholesaler_id = @wholesaler_id ' +
    '  AND wholesaler_invoice_id IS NULL ' +
    '  AND created_at >= TIMESTAMP(DATE_TRUNC(CURRENT_DATE(\'Asia/Tokyo\'), MONTH), \'Asia/Tokyo\') ' +
    '  AND created_at < TIMESTAMP(DATE_ADD(DATE_TRUNC(CURRENT_DATE(\'Asia/Tokyo\'), MONTH), INTERVAL 1 MONTH), \'Asia/Tokyo\')';

  const params = [
    { name: 'wholesaler_id', parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
  ];

  const rows = runQuery_(config.gcpProjectId, sql, params);
  return rows.length > 0 && Number(rows[0].cnt) > 0;
}

/**
 * 卸業者IDに紐づくビジネスカレンダー（スケジュール）を BQ から取得する。
 * 卸向け表示フラグ (is_visible_to_wholesaler = TRUE) の全 event_type を返す。
 * ※ 表示対象の制御は BQ 側の is_visible_to_wholesaler で行う。
 *
 * @param {number} wholesalerId - 卸業者ID
 * @returns {Array<Object>} スケジュール行の配列
 * @throws {Error} クエリ失敗時
 */
function fetchBusinessCalendar_(wholesalerId) {
  const config = getConfig_();
  const sql =
    'SELECT ' +
    '  event_type, start_at, end_at, event_description, display_color_code ' +
    'FROM `' + config.gcpProjectId + '.' + config.bqDatasetId + '.business_calendar` ' +
    'WHERE wholesaler_id = @wholesaler_id ' +
    '  AND is_visible_to_wholesaler = TRUE ' +
    'ORDER BY start_at ASC';

  const params = [
    { name: 'wholesaler_id', parameterType: { type: 'INT64' }, parameterValue: { value: String(wholesalerId) } },
  ];

  return runQuery_(config.gcpProjectId, sql, params);
}