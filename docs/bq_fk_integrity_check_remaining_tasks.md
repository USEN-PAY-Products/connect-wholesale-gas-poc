# 残タスク: BigQuery 外部キー不整合検知バッチ (MYP-3761)

本ドキュメントは、コード実装完了後にデプロイ・運用開始までに必要な残作業をまとめたものです。
コード一式（`tools/bq-integrity-check/` および `.github/workflows/bq_integrity_check.yml`）は実装・ビルド検証済みです。

## ✅ 実装完了済み（参考）

- [x] `tools/bq-integrity-check/package.json` / `tsconfig.json`
- [x] `tools/bq-integrity-check/src/checker.ts`（6検証SQL / ログINSERT / BQコンソールURL生成 / Slack通知）
- [x] `tools/bq-integrity-check/.env.example` / `.gitignore` / `README.md`
- [x] `.github/workflows/bq_integrity_check.yml`（日次cron + 手動実行 + WIF + 3回リトライ）
- [x] `npm install` / `npm run build`（tsc strict）でのビルド検証

---

## 1. GCP / インフラ設定

- [ ] **Workload Identity Federation の構築**
  - [ ] Workload Identity Pool を作成
  - [ ] GitHub OIDC 用の Provider を作成（issuer: `https://token.actions.githubusercontent.com`）
  - [ ] リポジトリ条件で属性制限（`assertion.repository == 'USEN-PAY-Products/connect-wholesale-gas-poc'` など）
- [ ] **サービスアカウント（SA）の用意**
  - [ ] バッチ実行用 SA を作成（例: `bq-integrity-check@usenpay-connect-dev.iam.gserviceaccount.com`）
  - [ ] `roles/bigquery.jobUser`（クエリ実行）を付与
  - [ ] `roles/bigquery.dataEditor`（`data_integrity_logs` 作成・書込）を付与
  - [ ] 検証対象データセット `connect_db` への参照権限を確認
- [ ] **WIF と SA のバインディング**
  - [ ] SA に `roles/iam.workloadIdentityUser` を付与し、対象リポジトリの principalSet と紐付け
- [ ] **ログテーブル**（任意）
  - [ ] スクリプトが `CREATE TABLE IF NOT EXISTS` で自動作成するが、事前に手動作成しておくと初回のストリーミング挿入の伝播待ちを回避できる

## 2. GitHub 設定（Environment: development）

- [ ] **Secrets 登録**
  - [ ] `GCP_WORKLOAD_IDENTITY_PROVIDER`（WIF プロバイダのリソース名）
  - [ ] `GCP_SERVICE_ACCOUNT`（SA のメールアドレス）
  - [ ] `SLACK_WEBHOOK_URL`（Slack Incoming Webhook URL）
- [ ] **Variables 登録（任意。未設定時はスクリプト既定値）**
  - [ ] `GCP_PROJECT_ID`（既定 `usenpay-connect-dev`）
  - [ ] `BQ_DATASET_ID`（既定 `connect_db`）
  - [ ] `BQ_LOCATION`（既定 `asia-northeast1`）
  - [ ] `LOOKER_STUDIO_URL`
  - [ ] `APP_ENV`（Slack 表示用ラベル。例 `development`）

## 3. Slack 設定

- [ ] 通知先チャンネルの決定（dev / prod を分けるか）
- [ ] Slack App で Incoming Webhook を作成し、URL を取得
- [ ] 取得した URL を GitHub Secret `SLACK_WEBHOOK_URL` に登録

## 4. Looker Studio 設定

- [ ] `connect_db.data_integrity_logs` をデータソースとして接続
- [ ] ダッシュボード作成
  - [ ] 不整合件数の日次トレンド（`checked_at` 軸）
  - [ ] 子テーブル / 親テーブル別の内訳
  - [ ] 不整合レコード一覧（`child_id` で検索・絞り込み）
- [ ] レポートの共有 URL を取得 → Variable `LOOKER_STUDIO_URL` に設定

## 5. 動作確認 / テスト

- [ ] **ローカル動作確認**
  - [ ] `gcloud auth application-default login` で ADC 認証
  - [ ] `.env` を作成し `npm run check`（前日分）を実行
  - [ ] `npm run check:all`（全件スキャン）を実行
  - [ ] 不整合 0 件時に Slack 通知が行われないことを確認
- [ ] **GitHub Actions 動作確認**
  - [ ] `workflow_dispatch` で手動実行（`all_records=false`）
  - [ ] `all_records=true` で全件スキャンが走ることを確認
  - [ ] WIF 認証が成功することを確認
  - [ ] 一時エラー時に最大 3 回リトライされることを確認
- [ ] **結果検証**
  - [ ] `data_integrity_logs` に検知レコードが INSERT されること
  - [ ] Slack 通知の Block Kit レイアウト（件数サマリー / 先頭5件 / ほかN件）が正しいこと
  - [ ] BigQuery コンソール URL が開け、不整合レコードが抽出できること
  - [ ] Looker Studio リンクが機能すること

## 6. コード品質 / 追加実装（任意・今後の改善）

- [ ] ユニットテストの整備（SQL 生成 / サマリー化 / URL 生成ロジック）
- [ ] 本番（production）環境への対応（Environment 切替・cron や通知先の出し分け）
- [ ] 通知の重大度分け（件数閾値でメンション有無を制御 等）

## 7. リリース作業

- [ ] `develop` から引き継いだ `docs/` 配下の変更（modified）の扱いを整理
      （本タスクと無関係なものはコミット対象から除外する）
- [ ] 本ツール関連ファイルをコミット
      - `tools/bq-integrity-check/**`
      - `.github/workflows/bq_integrity_check.yml`
      > 注: `docs/plan/` は `.gitignore` 対象のため、本ドキュメントと設計書はリポジトリに含まれません。
      > 設計書を成果物として残す場合は追跡対象ディレクトリへの移動を検討してください。
- [ ] PR 作成 → レビュー → `develop` へマージ

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
