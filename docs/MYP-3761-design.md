# MYP-3761 BigQuery テーブル間データ不整合検知ツール 設計書

## 1. 概要

### 1.1 背景・目的

BigQuery の外部キー制約は `NOT ENFORCED` であり制約として強制されないため、親レコードが存在しない不整合データが物理的に発生し得る。本ツールは 9 テーブル・計 11 箇所の外部キーを日次で検証し、不整合を検知した場合に「履歴の永続化（BigQuery）」と「Slack 通知」を同時に行うことで、データ品質の劣化を早期に検知できるようにする。

### 1.2 関連チケット

- **MYP-3761**: テーブル間のデータ不整合を検知するツールを作成

### 1.3 用語定義

| 用語 | 説明 |
| --- | --- |
| NOT ENFORCED | BigQuery の主キー/外部キーは宣言できるが整合性は強制されない属性。不整合データを物理的に許容する |
| 外部キー不整合 | 子テーブルの外部キーに対応する親レコードが存在しない状態（`LEFT JOIN` 時に親が `IS NULL`） |
| `data_integrity_logs` | 検知した不整合を蓄積する永続化テーブル。Looker Studio のデータソースになる |
| WIF | Workload Identity Federation。鍵ファイルを使わず OIDC で Google Cloud に認証する仕組み |
| Block Kit | Slack のリッチメッセージ構築フォーマット |
| 前日分スキャン | スキャンコスト最小化のため、判定日付カラムが「実行日の前日（JST）」のレコードのみを対象とする既定動作 |

## 2. 全体アーキテクチャ

### 2.1 処理フロー

```text
[GitHub Actions (日次 cron)]
        │ 1. WIF (OIDC) で Google Cloud に認証
        ▼
[checker.ts] ──2. data_integrity_logs を CREATE TABLE IF NOT EXISTS で確保
        │
        │ 3. 6 つの検証クエリを並列実行 (LEFT JOIN で親欠損を検知)
        ├──────────────┬───────────────┐
        ▼              ▼               ▼
   [BigQuery]    [data_integrity_logs] [Slack] (不整合あり時のみ)
  (親欠損を検知)   (検知レコードをINSERT)  (件数サマリ/BQコンソールURL/
        │                              Looker Studio URL を通知)
        ▼
  [Looker Studio] (履歴・トレンド・一覧の可視化)
```

- **実行環境**: GitHub Actions の cron（毎日 UTC 18:30 / JST 03:30）。手動実行（`workflow_dispatch`）も可能。
- **実行言語**: Node.js 20 / TypeScript（`tsc` strict ビルド）。
- **認証方式**: Workload Identity Federation (OIDC)。サービスアカウントキーは使用しない。
- **通知トリガー**: 不整合が 1 件以上検出された場合のみ Slack 通知（正常時は通知せず GitHub Actions のログのみ）。

### 2.2 コンポーネント構成

| レイヤー | ファイル | 責務 |
| --- | --- | --- |
| バッチ本体 | `tools/bq-integrity-check/src/checker.ts` | 検証SQL実行・ログINSERT・BQコンソールURL生成・Slack通知 |
| ビルド設定 | `tools/bq-integrity-check/package.json` / `tsconfig.json` | 依存定義・`build`/`check`/`check:all` スクリプト |
| 実行環境変数 | `tools/bq-integrity-check/.env.example` | ローカル実行用の環境変数サンプル（ADC 接続） |
| CI/CD | `.github/workflows/bq_integrity_check.yml` | 日次cron・手動実行・WIF認証・最大3回リトライ |
| 永続化 | `connect_db.data_integrity_logs` | 不整合履歴の蓄積（Looker Studio データソース） |
| 可視化 | Looker Studio | 不整合のトレンド・内訳・一覧検索 |

## 3. 詳細設計

### 3.1 検証対象テーブルと外部キー（9 テーブル / 11 外部キー）

検証は 6 つのクエリ（`checker.ts` の `buildChecks()`）で計 11 箇所の外部キーをカバーする。

| ID | 子テーブル | 親テーブル | 結合キー | 判定日付カラム |
| --- | --- | --- | --- | --- |
| T002 | wholesaler_user | wholesalers | wholesaler_id = id | registration_at |
| T004 | wholesaler_merchants | wholesalers / store | wholesaler_id = id / mall_code | registration_at |
| T005 | wholesaler_invoices | wholesaler_user / wholesalers | wholesaler_user_id = id / wholesaler_id = id | wholesaler_invoice_date |
| T007 | store_invoices | wholesaler_invoices / wholesalers / invoice_numbers (※Nullable) / store | 各 FK | DATE(created_at) |
| T008 | invoice_lines | store_invoices | store_invoice_id = id | DATE(created_at) |
| T009 | business_calendar | wholesalers | wholesaler_id = id | year_month（直近2か月） |

> ※ `store_invoices.invoice_number_id` は Nullable。`NULL`（未採番）は正常とみなし、`invoice_number_id IS NOT NULL` かつ親（invoice_numbers）が欠損している場合のみ不整合として扱う。

### 3.2 ログ永続化テーブル (data_integrity_logs)

`checker.ts` が起動時に `CREATE TABLE IF NOT EXISTS` で存在を保証する。

```sql
CREATE TABLE IF NOT EXISTS `usenpay-connect-dev.connect_db.data_integrity_logs` (
  checked_at TIMESTAMP NOT NULL OPTIONS(description="検証実行日時"),
  child_table STRING NOT NULL OPTIONS(description="不整合が発生した子テーブル名"),
  parent_table STRING NOT NULL OPTIONS(description="欠損している親テーブル名"),
  fk_column STRING NOT NULL OPTIONS(description="対象の外部キーカラム名"),
  child_id STRING NOT NULL OPTIONS(description="不整合レコードのID (PRIMARY KEY)"),
  child_record_created_at TIMESTAMP OPTIONS(description="不整合レコード自体の作成日時")
)
PARTITION BY DATE(checked_at)
CLUSTER BY child_table, parent_table;
```

### 3.3 検知ロジック

各検知クエリは共通スキーマで結果を返し、そのまま `data_integrity_logs` へ INSERT できる。

- `child_table` / `parent_table` / `fk_column`: 文字列リテラル
- `child_id`: 子レコードの主キー。テーブル間の型差異（INT64 / STRING）を吸収するため `CAST(... AS STRING)` で返す
- `child_record_created_at`: 不整合レコード自体の作成日時。`TIMESTAMP` 型で返す

**前日分フィルタ**: 既定はスキャンコスト最小化のため、判定日付カラムが前日（JST）のレコードに限定する。

```sql
-- 判定日付カラム = DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 1 DAY)
WHERE p.id IS NULL
  AND (@all_records OR t.registration_at = DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 1 DAY))
```

**全件スキャン**: 環境変数 `ALL_RECORDS=true`、または CLI 引数 `--all-records` / `--all` を指定すると `@all_records` が `true` となり、`WHERE` の日付条件が短絡して全レコードが対象になる（初回投入・リカバリ用）。

### 3.4 ログ記録（ストリーミング挿入）

検知レコードはストリーミング挿入（`table.insert`）で `data_integrity_logs` に書き込む。テーブル作成直後はメタデータ伝播の遅延で `table not found` となり得るため、挿入は最大 5 回まで（4 秒間隔で）リトライする。

### 3.5 Slack 通知

不整合が 1 件以上ある場合のみ、Slack Incoming Webhook へ Block Kit 形式で通知する。`SLACK_WEBHOOK_URL` 未設定時は通知をスキップする。

- **ヘッダー**: 🔴 【重大】BigQuery データ不整合検知バッチ
- **基本情報**: 実行環境（dev/prod）、実行日時（JST）、対象範囲（全件スキャン / 前日分のみ）、合計違反件数
- **不整合詳細セクション**（テーブルごと）
  - 対象テーブル名・違反件数
  - 親欠損の内訳: `parent_table (fk_column)` ごとの件数
  - 先頭サマリー（最大 5 件の `child_id`、超過分は「ほか N 件」と表示）
  - 🔍 このエラーのクエリを BigQuery で開くリンク（原因特定用 SELECT を埋め込んだコンソール URL）
- **フッター**: 📊 Looker Studio で履歴と全件を確認するリンク（`LOOKER_STUDIO_URL` 設定時）

BigQuery コンソール URL は次の形式で生成する。

```text
https://console.cloud.google.com/bigquery?project=<PROJECT_ID>&q=<encodeURIComponent(SELECT文)>&page=queryresults
```

### 3.6 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GCP_PROJECT_ID` | `usenpay-connect-dev` | GCP プロジェクト ID |
| `BQ_DATASET_ID` | `connect_db` | BigQuery データセット ID |
| `BQ_LOCATION` | `asia-northeast1` | BigQuery ロケーション |
| `SLACK_WEBHOOK_URL` | （空） | Slack Incoming Webhook。未設定時は通知をスキップ |
| `LOOKER_STUDIO_URL` | （空） | Looker Studio ダッシュボード URL（Slack リンク用） |
| `ENV` | `development` | Slack 表示用の環境ラベル |
| `ALL_RECORDS` | `false` | `true` で日付フィルターを解除し全件スキャン |

### 3.7 GitHub Actions 構成

- **スケジュール**: `cron: '30 18 * * *'`（UTC 18:30 / JST 03:30）
- **手動実行**: `workflow_dispatch` の `all_records`（`type: boolean`、既定 `false`）で全件スキャンを選択可能
- **権限**: `id-token: write`（OIDC）／ `concurrency` で多重起動による二重通知を防止
- **手順**: チェックアウト → Node.js 20 セットアップ → `npm install` → `npm run build` → WIF 認証（`google-github-actions/auth@v2`）→ `nick-fields/retry@v3`（`max_attempts: 3` / `timeout_minutes: 10`）で `node dist/checker.js` を実行
- **GitHub Secrets**: `GCP_WORKLOAD_IDENTITY_PROVIDER` / `GCP_SERVICE_ACCOUNT` / `SLACK_WEBHOOK_URL`
- **GitHub Variables（任意）**: `GCP_PROJECT_ID` / `BQ_DATASET_ID` / `BQ_LOCATION` / `LOOKER_STUDIO_URL` / `APP_ENV`

## 4. エラーハンドリング

| エラーケース | 挙動 |
| --- | --- |
| BigQuery / ネットワークの一時エラー | プロセスを非ゼロ終了（exit 1）し、GitHub Actions 側で最大 3 回リトライ |
| ログテーブル作成直後の `table not found` | メタデータ伝播待ちとして挿入を最大 5 回（4 秒間隔）リトライ |
| ストリーミング挿入の行レベル失敗 | `PartialFailureError` の `errors` を出力し、リトライ上限超過で例外送出 |
| `SLACK_WEBHOOK_URL` 未設定 | 警告ログを出力し Slack 通知をスキップ（処理は正常終了） |
| 不整合 0 件 | ログINSERT・Slack通知を行わず正常終了（exit 0） |
| 上記以外の予期せぬ例外 | エラーを出力し exit 1（リトライ対象） |

## 5. テスト観点

- ローカル実行（`gcloud auth application-default login` による ADC）で `npm run check`（前日分）/ `npm run check:all`（全件）が動作すること
- `workflow_dispatch` の `all_records=false` / `true` がそれぞれ前日分・全件スキャンとして機能すること
- WIF 認証が成功すること、一時エラー時に最大 3 回リトライされること
- 不整合 0 件時に Slack 通知が行われないこと
- `data_integrity_logs` に検知レコードが INSERT されること（型・カラムが正しいこと）
- Slack の Block Kit レイアウト（件数サマリー / 親欠損内訳 / 先頭5件 / ほかN件）が正しいこと
- BigQuery コンソール URL から不整合レコードが抽出できること、Looker Studio リンクが機能すること
- `store_invoices.invoice_number_id` が `NULL` のレコードを誤検知しないこと

## 6. 備考

- デプロイ・運用開始までの残作業（WIF 構築 / サービスアカウント権限 / Slack・Looker Studio 設定など）は [docs/bq_fk_integrity_check_remaining_tasks.md](bq_fk_integrity_check_remaining_tasks.md) を参照。
- 本設計は POC 段階のものであり、本番（production）環境対応・通知の重大度分け・ユニットテスト整備は今後の改善とする。
