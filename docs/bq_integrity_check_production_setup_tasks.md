# 残タスク: BQ不整合バッチ Production環境セットアップ (MYP-3761)

最終更新: 2026-07-06

developでは稼働済みのBQ外部キー不整合検知バッチ（`tools/bq-integrity-check/` + `.github/workflows/bq_integrity_check.yml`）を、
production環境（GCPプロジェクト: `usenpay-connect-prd`）でも実行できるようにするための残タスクです。

参考: [docs/bq_fk_integrity_check_remaining_tasks.md](./bq_fk_integrity_check_remaining_tasks.md)（development構築時の完了記録）

---

## 1. GCP / インフラ設定

- [x] サービスアカウント作成: `connect-bq-prod@usenpay-connect-prd.iam.gserviceaccount.com`
  - キーは発行しない（WIF/OIDC認証のため不要。develop同様の設計）
- [x] IAMロール付与
  - [x] `roles/bigquery.jobUser`（クエリ実行）
  - [x] `roles/bigquery.dataEditor`（`data_integrity_logs` 作成・書込）
- [ ] **Workload Identity Pool 作成**（`usenpay-connect-prd` プロジェクト内、GCPコンソール「IAMと管理 > Workload Identity 連携」）
  - [ ] プール作成（例: `github-actions-pool`。developと同名でよい。プロジェクトが違うので名前が重複しても問題なし）
  - [ ] OIDCプロバイダ追加（発行元 `https://token.actions.githubusercontent.com`）
  - [ ] 属性マッピング設定（`google.subject = assertion.sub`、`attribute.repository = assertion.repository`）
  - [ ] 属性条件設定（`assertion.repository == 'USEN-PAY-Products/connect-wholesale-gas-poc'`）
- [ ] **サービスアカウントへのバインド**（サービスアカウント詳細画面 → 「アクセス権を持つプリンシパル」タブ → 「アクセスを許可」）
  - [ ] プリンシパルに `principalSet://iam.googleapis.com/projects/{プロジェクト番号}/locations/global/workloadIdentityPools/{プールID}/attribute.repository/USEN-PAY-Products/connect-wholesale-gas-poc` を入力
  - [ ] ロール `Workload Identity ユーザー`（`roles/iam.workloadIdentityUser`）を付与
  - [ ] 完成後、Providerのフルリソース名を控える
    - 形式: `projects/{プロジェクト番号}/locations/global/workloadIdentityPools/{プールID}/providers/{プロバイダID}`
- [ ] **ログテーブル / 検証対象テーブルの存在確認**（BigQueryコンソールで `usenpay-connect-prd` を直接確認）
  - [ ] `data_integrity_logs` テーブルが存在するか確認。無ければ [bq_table_create_ddl.sql](./plan/bq_table_create_ddl.sql) のDDLをプロジェクトID差し替えの上で実行
  - [ ] 検証対象9テーブル（`wholesalers` / `wholesaler_user` / `store` / `wholesaler_merchants` / `wholesaler_invoices` / `invoice_numbers` / `store_invoices` / `invoice_lines` / `business_calendar`）が本番データセットに存在すること

## 2. GitHub 設定（Environment: production）

- [ ] GitHubリポジトリの Settings > Environments で `production` Environment を新規作成
  - URL: `https://github.com/USEN-PAY-Products/connect-wholesale-gas-poc/settings/environments`
- [ ] **Secrets 登録**
  - [ ] `GCP_WORKLOAD_IDENTITY_PROVIDER`（上記1.で控えたProviderのフルリソース名）
  - [ ] `GCP_SERVICE_ACCOUNT`（`connect-bq-prod@usenpay-connect-prd.iam.gserviceaccount.com`）
  - [ ] `SLACK_WEBHOOK_URL`（本番通知チャンネル用に新規発行したWebhook URL）
- [ ] **Variables 登録**
  - [ ] `GCP_PROJECT_ID`（`usenpay-connect-prd`）
  - [ ] `BQ_DATASET_ID`（developと同じ `connect_db` を踏襲するか要確認）
  - [ ] `BQ_LOCATION`（developと同じ `asia-northeast1` になる見込み。要確認）
  - [ ] `LOOKER_STUDIO_URL`（本番用ダッシュボードの共有URL。3.で作成後に設定）
  - [ ] `APP_ENV`（`production`）

## 3. Slack 設定

- [ ] 本番通知先チャンネルの決定
- [ ] Slack App で本番用 Incoming Webhook を新規作成し、URLを取得（developとは別のURLを新規発行する）
- [ ] 取得したURLを GitHub Secret `SLACK_WEBHOOK_URL`（production Environment）に登録

## 4. Looker Studio 設定

- [ ] 本番BigQueryデータセットの `data_integrity_logs` をデータソースとして新規接続（またはdevelop版レポートを複製しデータソースのみ差し替え）
- [ ] ダッシュボード作成（develop同様: 日次トレンド / テーブル別内訳 / レコード一覧）
- [ ] レポートの共有URLを取得 → GitHub Variable `LOOKER_STUDIO_URL`（production）に設定

## 5. ワークフローファイルの修正

現状 [.github/workflows/bq_integrity_check.yml](../.github/workflows/bq_integrity_check.yml) は `environment: development` に固定されており、
production Environmentへの切替ロジックが存在しない。Secrets/Variablesを登録しただけでは本番実行に反映されないため、以下のいずれかの対応が必要。

- [ ] 対応方針の決定（要相談）
  - 案A: `workflow_dispatch` の入力（例: `target_env`）で `development`/`production` を選択できるようにし、`environment: ${{ inputs.target_env }}` のような形にする
  - 案B: スケジュール実行は常に `production` を使う（developへのcron実行は廃止 or 別ジョブ化）
  - 案C: developブランチ以外（例: 将来的にmainブランチ運用が入るなら）でのブランチ判定切替（[.github/workflows/deploy.yml](../.github/workflows/deploy.yml#L16) の `environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'development' }}` パターンを参考にできるが、このワークフローはpushトリガーではないため単純流用は不可）
- [ ] 方針決定後、ワークフローYAMLを編集

## 6. 動作確認 / テスト

- [ ] GitHub Actions の組織予算枯渇ブロッカーが解消済みか確認（develop側の課題。production対応前に解消要）
- [ ] `workflow_dispatch` で production 向けに手動実行し、WIF認証が成功することを確認
- [ ] `data_integrity_logs`（本番）に検知レコードがINSERTされることを確認
- [ ] Slack通知が本番チャンネルに届くことを確認
- [ ] Looker Studioリンクが機能することを確認

---

## 補足: development の値との対応関係

| 項目 | development の値 | production で必要な値 |
| --- | --- | --- |
| GCPプロジェクトID | `usenpay-connect-dev` | `usenpay-connect-prd` |
| サービスアカウント | `connect-bq-dev@usenpay-connect-dev.iam.gserviceaccount.com` | `connect-bq-prod@usenpay-connect-prd.iam.gserviceaccount.com`（作成済み） |
| WIF Pool/Provider | `github-actions-pool` / `github-actions-provider` | 未作成（要作成） |
| WIF Providerリソース名 | `projects/922908723040/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider` | 未確定 |
| Slack Webhook | 開発用チャンネル | 未作成（要新規発行） |
| Looker Studio URL | 開発用ダッシュボード | 未作成（要新規作成） |
| GitHub Environment名 | `development` | `production`（要作成） |
