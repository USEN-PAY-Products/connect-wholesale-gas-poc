# 残タスク: BigQuery 外部キー不整合検知バッチ (MYP-3761)

最終更新: 2026-06-25

本ドキュメントは、コード実装完了後にデプロイ・運用開始までに必要な残作業をまとめたものです。
コード一式（`tools/bq-integrity-check/` および `.github/workflows/bq_integrity_check.yml`）は実装・ビルド検証済みです。

## ✅ 完了済み

- [x] `tools/bq-integrity-check/package.json` / `tsconfig.json`
- [x] `tools/bq-integrity-check/src/checker.ts`（6検証SQL / ログINSERT / BQコンソールURL生成 / Slack通知）
- [x] `tools/bq-integrity-check/.env.example` / `.gitignore` / `README.md`
- [x] `.github/workflows/bq_integrity_check.yml`（日次cron + 手動実行 + WIF + 3回リトライ）
- [x] `npm install` / `npm run build`（tsc strict）でのビルド検証
- [x] GCP: Workload Identity Pool 作成（`github-actions-pool`）
- [x] GCP: OIDC プロバイダ作成（`github-actions-provider`、発行元 `https://token.actions.githubusercontent.com`）
- [x] GCP: WIF と SA（`connect-bq-dev`）のバインディング（`attribute.repository = USEN-PAY-Products/connect-wholesale-gas-poc`）
- [x] GitHub Secrets 登録（`development` Environment）
  - [x] `GCP_WORKLOAD_IDENTITY_PROVIDER`（`projects/922908723040/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider`）
  - [x] `GCP_SERVICE_ACCOUNT`（`connect-bq-dev@usenpay-connect-dev.iam.gserviceaccount.com`）
  - [x] `SLACK_WEBHOOK_URL`（開発用）
- [x] BQ: `data_integrity_logs` テーブルを手動作成済み
- [x] Looker Studio: `data_integrity_logs` をデータソースとして接続
- [x] Looker Studio: ダッシュボード作成（日次トレンド / テーブル別内訳 / レコード一覧）
- [x] GitHub Variables 登録（`development` Environment）
  - [x] `LOOKER_STUDIO_URL`

---

## 1. GCP / インフラ設定 ✅ 完了

- [x] **Workload Identity Federation の構築**
  - [x] Workload Identity Pool 作成（`github-actions-pool`）
  - [x] GitHub OIDC 用 Provider 作成（`github-actions-provider`、発行元 `https://token.actions.githubusercontent.com`）
  - [x] リポジトリ条件で属性制限（`assertion.repository == 'USEN-PAY-Products/connect-wholesale-gas-poc'`）
- [x] **サービスアカウント（SA）の用意**
  - [x] 既存 SA `connect-bq-dev@usenpay-connect-dev.iam.gserviceaccount.com` を流用
  - [x] `roles/bigquery.jobUser`（クエリ実行）付与済み
  - [x] `roles/bigquery.dataEditor`（`data_integrity_logs` 作成・書込）付与済み
- [x] **WIF と SA のバインディング**
  - [x] `attribute.repository = USEN-PAY-Products/connect-wholesale-gas-poc` 条件で紐付け完了
- [x] **ログテーブル**
  - [x] `data_integrity_logs` を手動作成済み（初回ストリーミング挿入の伝播待ちを回避）

## 2. GitHub 設定（Environment: development）✅ 完了

- [x] **Secrets 登録**
  - [x] `GCP_WORKLOAD_IDENTITY_PROVIDER`
  - [x] `GCP_SERVICE_ACCOUNT`
  - [x] `SLACK_WEBHOOK_URL`（開発用）
- [ ] **Variables 登録（任意。未設定時はスクリプト既定値）**
  - [ ] `GCP_PROJECT_ID`（既定 `usenpay-connect-dev`）
  - [ ] `BQ_DATASET_ID`（既定 `connect_db`）
  - [ ] `BQ_LOCATION`（既定 `asia-northeast1`）
  - [x] `LOOKER_STUDIO_URL`（登録済み）
  - [ ] `APP_ENV`（Slack 表示用ラベル。例 `development`）

## 3. Slack 設定 ✅ 完了

- [x] 通知先チャンネルの決定
- [x] Slack App で Incoming Webhook を作成し、URL を取得
- [x] 取得した URL を GitHub Secret `SLACK_WEBHOOK_URL` に登録

## 4. Looker Studio 設定 ✅ 完了

- [x] `connect_db.data_integrity_logs` をデータソースとして接続
- [x] ダッシュボード作成
  - [x] 不整合件数の日次トレンド（折れ線グラフ / `checked_at` 軸）
  - [x] テーブル別内訳（縦棒グラフ / `child_table` 軸）
  - [x] 不整合レコード一覧（表 / `checked_at` / `child_table` / `parent_table` / `fk_column` / `child_id`）
- [x] レポートの共有 URL を取得 → Variable `LOOKER_STUDIO_URL` に設定済み

## 5. 動作確認 / テスト

> 🔴 **ブロッカー**: GitHub Actions の組織予算（USEN-PAY-Products）が 100% 使用済みのため実行不可。
> 組織管理者に予算増額を依頼すること。
> 管理者向け操作場所: https://github.com/organizations/USEN-PAY-Products/settings/billing

> ⚠️ **前提**: `workflow_dispatch` での手動実行は、ワークフローファイルが `develop`（デフォルトブランチ）に存在する必要がある。PR #40 のマージ後に実施すること。

- [ ] **GitHub Actions 動作確認**
  - [ ] PR #40 を `develop` にマージ
  - [ ] `workflow_dispatch` で手動実行（`all_records=false`）
  - [ ] `all_records=true` で全件スキャンが走ることを確認
  - [ ] WIF 認証が成功することを確認
  - [ ] 一時エラー時に最大 3 回リトライされることを確認
- [ ] **結果検証**
  - [ ] `data_integrity_logs` に検知レコードが INSERT されること
  - [ ] Slack 通知の Block Kit レイアウト（件数サマリー / 先頭5件 / ほかN件）が正しいこと
  - [ ] BigQuery コンソール URL が開け、不整合レコードが抽出できること
  - [ ] Looker Studio リンクが機能すること（設定後）

## 6. コード品質 / 追加実装（任意・今後の改善）

- [ ] ユニットテストの整備（SQL 生成 / サマリー化 / URL 生成ロジック）
- [ ] 本番（production）環境への対応（Environment 切替・cron や通知先の出し分け）
- [ ] 通知の重大度分け（件数閾値でメンション有無を制御 等）

## 7. リリース作業

- [x] 本ツール関連ファイルをコミット・PR 作成（PR #40）
  - `tools/bq-integrity-check/**`
  - `.github/workflows/bq_integrity_check.yml`
- [ ] 動作確認完了後、PR #40 を `develop` へマージ
  > PR: https://github.com/USEN-PAY-Products/connect-wholesale-gas-poc/pull/40

---

## 補足: 環境変数とワークフローの対応

| 環境変数 | GHA での供給元 | 必須 | 備考 |
| --- | --- | --- | --- |
| `GCP_PROJECT_ID` | Variable | 任意 | 既定 `usenpay-connect-dev` |
| `BQ_DATASET_ID` | Variable | 任意 | 既定 `connect_db` |
| `BQ_LOCATION` | Variable | 任意 | 既定 `asia-northeast1` |
| `SLACK_WEBHOOK_URL` | Secret | 推奨 | 未設定時は通知スキップ |
| `LOOKER_STUDIO_URL` | Variable | 任意 | Slack リンク用 |
| `ENV` | Variable(`APP_ENV`) | 任意 | Slack 表示ラベル |
| `ALL_RECORDS` | `inputs.all_records` | 自動 | 手動実行時のみ true 可 |
