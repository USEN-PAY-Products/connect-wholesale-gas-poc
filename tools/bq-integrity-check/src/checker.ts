/**
 * =============================================================================
 * BigQuery 外部キー不整合検知・Slack/Looker Studio 通知バッチ (MYP-3761)
 *
 * BigQuery の外部キー制約は `NOT ENFORCED` のため、親レコードが存在しない
 * 不整合データが物理的に作られ得る。本スクリプトは 9 テーブル・計 11 箇所の
 * 外部キーを LEFT JOIN で検証し、不整合（親が IS NULL）を検知する。
 *
 * 処理フロー:
 *   1. ログ永続化テーブル data_integrity_logs を CREATE TABLE IF NOT EXISTS で確保
 *   2. 6 つの検証クエリを実行（既定は「前日分」のみ。ALL_RECORDS=true で全件）
 *   3. 検知レコードを data_integrity_logs へ INSERT（Looker Studio のデータソース）
 *   4. 各テーブルの「原因特定用 SELECT」を BigQuery コンソール URL に変換
 *   5. 1 件でも不整合があれば Slack（Block Kit）へリッチ通知
 *
 * 終了コード:
 *   - 正常（不整合の有無に関わらず処理完了）→ 0
 *   - BigQuery / Slack 等の予期せぬエラー → 1（GitHub Actions 側でリトライ対象）
 * =============================================================================
 */

import { BigQuery } from '@google-cloud/bigquery';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// ===== 環境変数 =========================================================
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'usenpay-connect-dev';
const BQ_DATASET_ID = process.env.BQ_DATASET_ID || 'connect_db';
const BQ_LOCATION = process.env.BQ_LOCATION || 'asia-northeast1';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const LOOKER_STUDIO_URL = process.env.LOOKER_STUDIO_URL || '';
const ENV_NAME = process.env.ENV || 'development';

/** ログ永続化テーブル名 */
const LOG_TABLE = 'data_integrity_logs';

/** Slack のテーブル別サマリーに載せる ID の最大件数 */
const SAMPLE_ID_LIMIT = 5;

/**
 * 全件スキャンモード判定。
 * 環境変数 ALL_RECORDS=true、または CLI 引数 --all-records / --all で有効化。
 */
const ALL_RECORDS =
  process.env.ALL_RECORDS === 'true' ||
  process.argv.includes('--all-records') ||
  process.argv.includes('--all');

const bigquery = new BigQuery({ projectId: GCP_PROJECT_ID });

// ===== 型定義 ===========================================================

/** BigQuery が TIMESTAMP を返すときのラッパー（{ value: ISO文字列 }） */
type BqTimestamp = { value: string };

/** 検証クエリ 1 行の結果 */
interface ViolationRow {
  child_table: string;
  parent_table: string;
  fk_column: string;
  child_id: string;
  child_record_created_at: BqTimestamp | string | null;
}

/** 1 つの検証チェック定義 */
interface CheckDefinition {
  /** 設計書上の ID（T002 等） */
  id: string;
  /** 調査対象の子テーブル名 */
  childTable: string;
  /** 不整合検知用 SQL（@all_records パラメータを含む） */
  detectSql: string;
  /** 原因特定用 SQL（日付フィルター無し・BQ コンソール URL に埋め込む） */
  investigateSql: string;
}

/** チェック実行結果 */
interface CheckResult {
  def: CheckDefinition;
  rows: ViolationRow[];
}

// ===== ユーティリティ ===================================================

/** 完全修飾テーブル名（`project.dataset.table`）を返す */
function fq(table: string): string {
  return `\`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${table}\``;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Date を Asia/Tokyo 表記の文字列にフォーマット */
function formatJst(d: Date): string {
  const s = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
  return `${s} (JST)`;
}

/** BigQuery TIMESTAMP 値を INSERT 用に正規化（null 許容） */
function toTimestampOrNull(
  v: BqTimestamp | string | null,
): ReturnType<BigQuery['timestamp']> | null {
  if (v == null) return null;
  const iso = typeof v === 'string' ? v : v.value;
  if (!iso) return null;
  return bigquery.timestamp(iso);
}

/**
 * 原因特定用 SELECT を埋め込んだ BigQuery コンソール URL を生成する。
 * 検知時、この URL を開けば不整合レコードを即座に抽出できる。
 */
function buildBqConsoleUrl(sql: string): string {
  const encodedQuery = encodeURIComponent(sql);
  return `https://console.cloud.google.com/bigquery?project=${GCP_PROJECT_ID}&q=${encodedQuery}&page=queryresults`;
}

// ===== 検証チェック定義（9 テーブル / 11 外部キー） ======================

/**
 * 検証チェックを構築する。
 * 既定は「前日分」のみ（判定日付カラムは JST 基準）。
 * @all_records が true のときは日付条件が短絡し全件対象になる。
 */
function buildChecks(): CheckDefinition[] {
  // 前日（JST）を表す共通式
  const YESTERDAY = `DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 1 DAY)`;

  return [
    // ---- T002: wholesaler_user → wholesalers ----------------------------
    {
      id: 'T002',
      childTable: 'wholesaler_user',
      detectSql: `
SELECT
  'wholesaler_user' AS child_table,
  'wholesalers' AS parent_table,
  'wholesaler_id' AS fk_column,
  CAST(t.id AS STRING) AS child_id,
  TIMESTAMP(t.registration_at) AS child_record_created_at
FROM ${fq('wholesaler_user')} t
LEFT JOIN ${fq('wholesalers')} p ON t.wholesaler_id = p.id
WHERE p.id IS NULL
  AND (@all_records OR t.registration_at = ${YESTERDAY})`,
      investigateSql: `SELECT t.*
FROM ${fq('wholesaler_user')} t
LEFT JOIN ${fq('wholesalers')} p ON t.wholesaler_id = p.id
WHERE p.id IS NULL;`,
    },

    // ---- T004: wholesaler_merchants → wholesalers / store ---------------
    {
      id: 'T004',
      childTable: 'wholesaler_merchants',
      detectSql: `
SELECT
  'wholesaler_merchants' AS child_table,
  CASE WHEN w.id IS NULL THEN 'wholesalers' ELSE 'store' END AS parent_table,
  CASE WHEN w.id IS NULL THEN 'wholesaler_id' ELSE 'mall_code' END AS fk_column,
  CAST(t.id AS STRING) AS child_id,
  TIMESTAMP(t.registration_at) AS child_record_created_at
FROM ${fq('wholesaler_merchants')} t
LEFT JOIN ${fq('wholesalers')} w ON t.wholesaler_id = w.id
LEFT JOIN ${fq('store')} s ON t.mall_code = s.mall_code
WHERE (w.id IS NULL OR s.mall_code IS NULL)
  AND (@all_records OR t.registration_at = ${YESTERDAY})`,
      investigateSql: `SELECT t.*
FROM ${fq('wholesaler_merchants')} t
LEFT JOIN ${fq('wholesalers')} w ON t.wholesaler_id = w.id
LEFT JOIN ${fq('store')} s ON t.mall_code = s.mall_code
WHERE w.id IS NULL OR s.mall_code IS NULL;`,
    },

    // ---- T005: wholesaler_invoices → wholesaler_user / wholesalers ------
    {
      id: 'T005',
      childTable: 'wholesaler_invoices',
      detectSql: `
SELECT
  'wholesaler_invoices' AS child_table,
  CASE WHEN wu.id IS NULL THEN 'wholesaler_user' ELSE 'wholesalers' END AS parent_table,
  CASE WHEN wu.id IS NULL THEN 'wholesaler_user_id' ELSE 'wholesaler_id' END AS fk_column,
  CAST(t.id AS STRING) AS child_id,
  TIMESTAMP(t.wholesaler_invoice_date) AS child_record_created_at
FROM ${fq('wholesaler_invoices')} t
LEFT JOIN ${fq('wholesaler_user')} wu ON t.wholesaler_user_id = wu.id
LEFT JOIN ${fq('wholesalers')} w ON t.wholesaler_id = w.id
WHERE (wu.id IS NULL OR w.id IS NULL)
  AND (@all_records OR t.wholesaler_invoice_date = ${YESTERDAY})`,
      investigateSql: `SELECT t.*
FROM ${fq('wholesaler_invoices')} t
LEFT JOIN ${fq('wholesaler_user')} wu ON t.wholesaler_user_id = wu.id
LEFT JOIN ${fq('wholesalers')} w ON t.wholesaler_id = w.id
WHERE wu.id IS NULL OR w.id IS NULL;`,
    },

    // ---- T007: store_invoices → wholesaler_invoices / wholesalers /
    //            invoice_numbers(Nullable) / store -------------------------
    // 注: invoice_number_id は Nullable。値が NULL の場合は正常（未採番）なので、
    //     親欠損とみなすのは「invoice_number_id が NOT NULL なのに親が無い」場合のみ。
    {
      id: 'T007',
      childTable: 'store_invoices',
      detectSql: `
SELECT
  'store_invoices' AS child_table,
  CASE
    WHEN wi.id IS NULL THEN 'wholesaler_invoices'
    WHEN w.id IS NULL THEN 'wholesalers'
    WHEN t.invoice_number_id IS NOT NULL AND inum.id IS NULL THEN 'invoice_numbers'
    ELSE 'store'
  END AS parent_table,
  CASE
    WHEN wi.id IS NULL THEN 'wholesaler_invoice_id'
    WHEN w.id IS NULL THEN 'wholesaler_id'
    WHEN t.invoice_number_id IS NOT NULL AND inum.id IS NULL THEN 'invoice_number_id'
    ELSE 'mall_code'
  END AS fk_column,
  CAST(t.id AS STRING) AS child_id,
  t.created_at AS child_record_created_at
FROM ${fq('store_invoices')} t
LEFT JOIN ${fq('wholesaler_invoices')} wi ON t.wholesaler_invoice_id = wi.id
LEFT JOIN ${fq('wholesalers')} w ON t.wholesaler_id = w.id
LEFT JOIN ${fq('invoice_numbers')} inum ON t.invoice_number_id = inum.id
LEFT JOIN ${fq('store')} s ON t.mall_code = s.mall_code
WHERE (
    wi.id IS NULL
    OR w.id IS NULL
    OR (t.invoice_number_id IS NOT NULL AND inum.id IS NULL)
    OR s.mall_code IS NULL
  )
  AND (@all_records OR DATE(t.created_at, 'Asia/Tokyo') = ${YESTERDAY})`,
      investigateSql: `SELECT t.*
FROM ${fq('store_invoices')} t
LEFT JOIN ${fq('wholesaler_invoices')} wi ON t.wholesaler_invoice_id = wi.id
LEFT JOIN ${fq('wholesalers')} w ON t.wholesaler_id = w.id
LEFT JOIN ${fq('invoice_numbers')} inum ON t.invoice_number_id = inum.id
LEFT JOIN ${fq('store')} s ON t.mall_code = s.mall_code
WHERE wi.id IS NULL OR w.id IS NULL OR (t.invoice_number_id IS NOT NULL AND inum.id IS NULL) OR s.mall_code IS NULL;`,
    },

    // ---- T008: invoice_lines → store_invoices ---------------------------
    {
      id: 'T008',
      childTable: 'invoice_lines',
      detectSql: `
SELECT
  'invoice_lines' AS child_table,
  'store_invoices' AS parent_table,
  'store_invoice_id' AS fk_column,
  CAST(t.id AS STRING) AS child_id,
  t.created_at AS child_record_created_at
FROM ${fq('invoice_lines')} t
LEFT JOIN ${fq('store_invoices')} p ON t.store_invoice_id = p.id
WHERE p.id IS NULL
  AND (@all_records OR DATE(t.created_at, 'Asia/Tokyo') = ${YESTERDAY})`,
      investigateSql: `SELECT t.*
FROM ${fq('invoice_lines')} t
LEFT JOIN ${fq('store_invoices')} p ON t.store_invoice_id = p.id
WHERE p.id IS NULL;`,
    },

    // ---- T009: business_calendar → wholesalers --------------------------
    // 月初日付（year_month）基準。直近 2 か月分を対象にする。
    {
      id: 'T009',
      childTable: 'business_calendar',
      detectSql: `
SELECT
  'business_calendar' AS child_table,
  'wholesalers' AS parent_table,
  'wholesaler_id' AS fk_column,
  CAST(t.id AS STRING) AS child_id,
  TIMESTAMP(t.year_month) AS child_record_created_at
FROM ${fq('business_calendar')} t
LEFT JOIN ${fq('wholesalers')} p ON t.wholesaler_id = p.id
WHERE p.id IS NULL
  AND (@all_records OR t.year_month >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 2 MONTH))`,
      investigateSql: `SELECT t.*
FROM ${fq('business_calendar')} t
LEFT JOIN ${fq('wholesalers')} p ON t.wholesaler_id = p.id
WHERE p.id IS NULL;`,
    },
  ];
}

// ===== BigQuery 操作 ====================================================

/** ログ永続化テーブルが無ければ作成する */
async function ensureLogTable(): Promise<void> {
  const ddl = `CREATE TABLE IF NOT EXISTS ${fq(LOG_TABLE)} (
  checked_at TIMESTAMP NOT NULL OPTIONS(description="検証実行日時"),
  child_table STRING NOT NULL OPTIONS(description="不整合が発生した子テーブル名"),
  parent_table STRING NOT NULL OPTIONS(description="欠損している親テーブル名"),
  fk_column STRING NOT NULL OPTIONS(description="対象の外部キーカラム名"),
  child_id STRING NOT NULL OPTIONS(description="不整合レコードのID (PRIMARY KEY)"),
  child_record_created_at TIMESTAMP OPTIONS(description="不整合レコード自体の作成日時")
)
PARTITION BY DATE(checked_at)
CLUSTER BY child_table, parent_table`;

  await bigquery.query({ query: ddl, location: BQ_LOCATION });
  console.log(`[ensureLogTable] ${BQ_DATASET_ID}.${LOG_TABLE} を確認/作成しました。`);
}

/** 1 つの検証チェックを実行する */
async function runCheck(def: CheckDefinition): Promise<CheckResult> {
  const [rows] = await bigquery.query({
    query: def.detectSql,
    params: { all_records: ALL_RECORDS },
    location: BQ_LOCATION,
  });
  return { def, rows: rows as ViolationRow[] };
}

/**
 * 検知レコードをログテーブルへ INSERT する（ストリーミング挿入）。
 * 作成直後のテーブルへ挿入する初回実行では「table not found」になり得るため、
 * メタデータ伝播待ちのリトライを内包する。
 */
async function insertLogs(rows: ViolationRow[], checkedAt: Date): Promise<void> {
  if (rows.length === 0) return;

  const checkedAtTs = bigquery.timestamp(checkedAt);
  const payload: Record<string, unknown>[] = rows.map((r) => ({
    checked_at: checkedAtTs,
    child_table: r.child_table,
    parent_table: r.parent_table,
    fk_column: r.fk_column,
    child_id: String(r.child_id),
    child_record_created_at: toTimestampOrNull(r.child_record_created_at),
  }));

  const table = bigquery.dataset(BQ_DATASET_ID).table(LOG_TABLE);
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await table.insert(payload);
      console.log(`[insertLogs] ${payload.length} 件を ${LOG_TABLE} へ記録しました。`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isFreshTableRace = /not found|notfound|not.*ready/i.test(message);
      if (attempt >= maxAttempts || !isFreshTableRace) {
        // PartialFailureError の詳細を可能な限り出力
        const partialErrors = (err as { errors?: unknown }).errors;
        if (partialErrors) {
          console.error('[insertLogs] 行レベルの挿入エラー:', JSON.stringify(partialErrors, null, 2));
        }
        throw err;
      }
      console.warn(
        `[insertLogs] テーブル伝播待ち（${attempt}/${maxAttempts}）。4 秒後に再試行します。`,
      );
      await sleep(4000);
    }
  }
}

// ===== サマリー / Slack 通知 ============================================

/** チェック結果を Slack 表示用に集計する */
function summarizeResult(res: CheckResult): {
  count: number;
  breakdownLines: string[];
  sampleIds: string[];
} {
  const count = res.rows.length;

  // 親テーブル(外部キー)別の件数内訳
  const byParent = new Map<string, number>();
  for (const r of res.rows) {
    const key = `${r.parent_table} (${r.fk_column})`;
    byParent.set(key, (byParent.get(key) ?? 0) + 1);
  }
  const breakdownLines = [...byParent.entries()].map(
    ([key, num]) => `　• 親欠損: \`${key}\` … ${num} 件`,
  );

  const sampleIds = res.rows.slice(0, SAMPLE_ID_LIMIT).map((r) => String(r.child_id));

  return { count, breakdownLines, sampleIds };
}

/** Slack（Block Kit）メッセージのブロック配列を構築する */
function buildSlackBlocks(
  results: CheckResult[],
  checkedAt: Date,
  totalCount: number,
): unknown[] {
  const scopeLabel = ALL_RECORDS ? '全件スキャン' : '前日分のみ';
  const blocks: unknown[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '🔴 【重大】BigQuery データ不整合検知バッチ', emoji: true },
  });

  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*実行環境:*\n${ENV_NAME}` },
      { type: 'mrkdwn', text: `*実行日時:*\n${formatJst(checkedAt)}` },
      { type: 'mrkdwn', text: `*対象範囲:*\n${scopeLabel}` },
      { type: 'mrkdwn', text: `*合計違反件数:*\n*${totalCount.toLocaleString()}* 件` },
    ],
  });

  blocks.push({ type: 'divider' });

  for (const res of results) {
    if (res.rows.length === 0) continue;

    const { count, breakdownLines, sampleIds } = summarizeResult(res);
    const omitted = count - sampleIds.length;

    const sampleLines = sampleIds.map((id) => `　\`${id}\``);
    if (omitted > 0) {
      sampleLines.push(`　（ほか ${omitted.toLocaleString()} 件の不整合レコードが存在します）`);
    }

    const sectionText = [
      `*⚠️ 対象テーブル: \`${res.def.childTable}\`*  —  *${count.toLocaleString()} 件*`,
      ...breakdownLines,
      `*先頭サマリー（最大 ${SAMPLE_ID_LIMIT} 件）:*`,
      ...sampleLines,
    ].join('\n');

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: sectionText } });

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🔍 <${buildBqConsoleUrl(res.def.investigateSql)}|このエラーのクエリを BigQuery で開く>`,
        },
      ],
    });

    blocks.push({ type: 'divider' });
  }

  // フッター: Looker Studio リンク
  if (LOOKER_STUDIO_URL) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📊 <${LOOKER_STUDIO_URL}|Looker Studio で履歴と全件を確認する>`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `BigQuery FK Integrity Check ・ \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}\``,
      },
    ],
  });

  return blocks;
}

/** Slack Incoming Webhook へ通知を送信する */
async function sendSlackNotification(blocks: unknown[]): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.warn(
      '[sendSlackNotification] SLACK_WEBHOOK_URL が未設定のため Slack 通知をスキップしました。',
    );
    return;
  }

  await axios.post(
    SLACK_WEBHOOK_URL,
    {
      text: '🔴 BigQuery データ不整合を検知しました',
      blocks,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
  );
  console.log('[sendSlackNotification] Slack へ通知を送信しました。');
}

// ===== メイン ===========================================================

async function main(): Promise<void> {
  const checkedAt = new Date();

  console.log('==============================================================');
  console.log(' BigQuery 外部キー不整合検知バッチ');
  console.log(`   project : ${GCP_PROJECT_ID}`);
  console.log(`   dataset : ${BQ_DATASET_ID}`);
  console.log(`   location: ${BQ_LOCATION}`);
  console.log(`   scope   : ${ALL_RECORDS ? 'ALL records' : 'previous day only'}`);
  console.log(`   started : ${formatJst(checkedAt)}`);
  console.log('==============================================================');

  // 1. ログテーブルの存在を保証
  await ensureLogTable();

  // 2. 全チェックを並列実行
  const checks = buildChecks();
  const results = await Promise.all(checks.map((def) => runCheck(def)));

  // コンソールへ件数サマリーを出力
  for (const res of results) {
    console.log(`  - ${res.def.id} ${res.def.childTable.padEnd(22)} : ${res.rows.length} 件`);
  }

  // 3. 不整合レコードを集約
  const allViolations = results.flatMap((r) => r.rows);
  const totalCount = allViolations.length;

  if (totalCount === 0) {
    console.log('✅ 不整合は検出されませんでした。Slack 通知は行いません。');
    return;
  }

  console.log(`⚠️ 合計 ${totalCount} 件の不整合を検出しました。`);

  // 4. ログテーブルへ INSERT（Looker Studio のデータソース）
  await insertLogs(allViolations, checkedAt);

  // 5. Slack 通知
  const blocks = buildSlackBlocks(results, checkedAt, totalCount);
  await sendSlackNotification(blocks);

  console.log('✅ 処理が完了しました。');
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error('❌ バッチ実行中にエラーが発生しました:', err);
    // 非ゼロ終了で GitHub Actions のリトライ対象とする
    process.exitCode = 1;
  });
