# BigQuery 外部キー不整合検知バッチ (MYP-3761)

BigQuery（`usenpay-connect-dev.connect_db`）の外部キー制約は `NOT ENFORCED` のため、
親レコードが存在しない不整合データが物理的に発生し得ます。本ツールは 9 テーブル・
計 11 箇所の外部キーを `LEFT JOIN` で検証し、不整合を検知すると次の 2 つを同時に行います。

1. **履歴の永続化**: 不整合レコードを `connect_db.data_integrity_logs` に INSERT（Looker Studio のデータソース）
2. **Slack 通知**: Block Kit 形式で、件数サマリー・原因特定用 BigQuery コンソール URL・Looker Studio URL を通知

> 既定では「前日分」のみをスキャンしてコストを最小化します。全件スキャンは `ALL_RECORDS=true`（または `--all-records`）で実行します。

## ディレクトリ構成

```text
tools/bq-integrity-check/
├── package.json
├── tsconfig.json
├── .env.example
└── src/checker.ts
.github/workflows/bq_integrity_check.yml
```

## ローカル実行

```bash
cd tools/bq-integrity-check
cp .env.example .env          # 値を編集（SLACK_WEBHOOK_URL / LOOKER_STUDIO_URL 等）
gcloud auth application-default login   # ADC で BigQuery に接続

npm install
npm run check                 # 前日分のみスキャン
npm run check:all             # 全件スキャン（--all-records）
```

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GCP_PROJECT_ID` | `usenpay-connect-dev` | GCP プロジェクト ID |
| `BQ_DATASET_ID` | `connect_db` | BigQuery データセット ID |
| `BQ_LOCATION` | `asia-northeast1` | BigQuery ロケーション |
| `SLACK_WEBHOOK_URL` | （空） | Slack Incoming Webhook。未設定時は通知をスキップ |
| `LOOKER_STUDIO_URL` | （空） | Looker Studio ダッシュボード URL（Slack リンク用） |
| `ENV` | `development` | Slack 表示用の環境ラベル |
| `ALL_RECORDS` | `false` | `true` で日付フィルターを解除し全件スキャン |

## GitHub Actions

- スケジュール: 毎日 **UTC 18:30 / JST AM 3:30**
- 手動実行: `workflow_dispatch` の `all_records`(boolean) で全件スキャンを選択可能
- 認証: Workload Identity Federation(OIDC)
- リトライ: `nick-fields/retry@v3` で最大 3 回

### 事前設定（Secrets / Variables）

| 種別 | 名前 | 用途 |
| --- | --- | --- |
| Secret | `GCP_WORKLOAD_IDENTITY_PROVIDER` | WIF プロバイダのリソース名 |
| Secret | `GCP_SERVICE_ACCOUNT` | 紐付けるサービスアカウントのメール |
| Secret | `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL |
| Variable | `GCP_PROJECT_ID` / `BQ_DATASET_ID` / `BQ_LOCATION` | BigQuery 接続先（任意） |
| Variable | `LOOKER_STUDIO_URL` | Looker Studio ダッシュボード URL（任意） |
| Variable | `APP_ENV` | 環境ラベル（任意） |

サービスアカウントには対象データセットへの参照権限と、ログテーブル作成/書込のため
`roles/bigquery.dataEditor`（または同等）と `roles/bigquery.jobUser` を付与してください。

## 検証対象（9 テーブル / 11 外部キー）

| 子テーブル | 親テーブル | 結合キー | 判定日付カラム |
| --- | --- | --- | --- |
| wholesaler_user | wholesalers | wholesaler_id = id | registration_at |
| wholesaler_merchants | wholesalers / store | wholesaler_id = id / mall_code | registration_at |
| wholesaler_invoices | wholesaler_user / wholesalers | wholesaler_user_id = id / wholesaler_id = id | wholesaler_invoice_date |
| store_invoices | wholesaler_invoices / wholesalers / invoice_numbers(※Nullable) / store | 各 FK | DATE(created_at) |
| invoice_lines | store_invoices | store_invoice_id = id | DATE(created_at) |
| business_calendar | wholesalers | wholesaler_id = id | year_month（直近2か月） |

> `store_invoices.invoice_number_id` は Nullable のため、`IS NOT NULL` かつ親が欠損している場合のみ不整合として扱います。
