# 卸システム（Wholesaler System）要件・設計定義書

> **最終更新**: 2026-06-30

## 1. システムの役割

本システムは、卸業者が請求データ（CSV）をアップロードし、その後の審査・支払いステータスを確認するための Web アプリケーションです。
Google Apps Script（GAS）上で SPA として動作し、データストアとして **BigQuery** を直接使用します。

### アーキテクチャ概要

```
[ブラウザ(SPA)] ←→ [GAS Backend] ←→ [BigQuery]
                                    ←→ [Google Drive（CSV保存）]
```

- **フロントエンド**: GAS の HtmlService で配信する SPA（ハッシュルーター）
- **バックエンド**: GAS の `google.script.run` 経由で呼び出されるサーバーサイド関数
- **データストア**: BigQuery（トランザクション SQL によるデータ整合性保証）
- **ファイル保存**: Google Drive（アップロード CSV の原本保管）
- **認証**: Google OAuth + 外部アカウント認証（セッショントークン方式）

## 2. 主要機能（画面UI）

### 2.1 ホーム画面（請求履歴一覧）
- **機能**: 卸業者に紐づく全請求書の一覧表示・ステータス確認。
- **処理フロー**:
    1. ログイン中の卸業者IDで BigQuery から請求一覧を取得。
    2. 請求スケジュールカレンダーの表示（締め日・支払日の確認）。
    3. 各請求書のステータスバッジ表示（要再提出・否認等）。
    4. 請求書クリックで詳細画面へ遷移。

### 2.2 CSVアップロード & プレビュー画面
- **機能**: ユーザーが手元の請求CSVを選択し、登録前に内容を確認する画面。
- **処理フロー**:
    1. CSVを読み込み、フロントエンドでパース・バリデーション。
    2. 卸ごとの `csv_format_rules`（列マッピング設定）に基づくヘッダー検証。
    3. 加盟店単位の金額サマリー表示。
    4. 「送信」ボタン押下で確認画面へ遷移。

### 2.3 確認画面
- **機能**: アップロードデータの最終確認・送信。
- **処理フロー**:
    1. 卸全体・加盟店別の金額サマリー表示。
    2. 加盟店ごとの備考入力。
    3. 「確定」ボタンで BigQuery へトランザクション SQL を実行。
    4. CSV原本を Google Drive に保存。

### 2.4 詳細画面
- **機能**: 請求書の詳細情報・加盟店別ステータス確認・アクション実行。
- **主な機能**:
    - 加盟店ごとのステータス（差戻し・否認・承認等）表示。
    - 個別 CSV 再アップロード（修正ファイルアップロードモーダル）。
    - 一括 CSV 再送信。
    - 変更なし再請求。
    - 請求取り下げ / 取り下げ取消。
    - 請求スケジュールカレンダー。

### 2.5 エラーページ
- **機能**: 認証エラー・セッション期限切れ等の案内表示。

## 3. 内部ロジック

### 3.1 通信方式
- **フロント → バックエンド**: `google.script.run.withSuccessHandler().withFailureHandler()` を使用。
- **バックエンド → BigQuery**: GAS の `UrlFetchApp` で BigQuery REST API を直接呼び出し（OAuth2トークン使用）。
- **バックエンド → Drive**: GAS の DriveApp / Drive API で CSV ファイルを保存。

### 3.2 データ登録フロー（CSV → BQ）
1. フロントで CSV パース・バリデーション。
2. Base64 エンコードしてバックエンドへ送信。
3. BQ Load Job でステージングテーブルにCSVデータを投入。
4. トランザクション SQL で `store_invoices` + `invoice_lines` + `wholesaler_invoices` を一括操作。
5. ステージングテーブルを DROP。

### 3.3 再申請時のデータ更新方式

| テーブル | 操作 | 説明 |
|---------|------|------|
| `wholesaler_invoices` | **INSERT（新規作成）** | 新UUIDで作成。`wholesaler_invoice_id` に大元IDをセットしバージョン管理 |
| `store_invoices`（旧） | **UPDATE** | `is_latest = FALSE` に更新し非活性化 |
| `store_invoices`（新） | **INSERT（新規作成）** | 新UUIDで作成。`wholesaler_invoice_id` は新 `wholesaler_invoices.id` を参照 |
| `invoice_lines` | **INSERT（新規作成）** | ステージングテーブルから JOIN して生成 |

## 4. データモデル（主要テーブル）

### 4.1 wholesaler_invoices（卸請求書）
卸単位の請求書。再申請時は新レコードを INSERT し、`wholesaler_invoice_id` で親子関係を管理。

| カラム | 説明 |
|--------|------|
| `id` | 主キー（UUID） |
| `wholesaler_id` | 卸業者ID |
| `wholesaler_invoice_date` | 請求日 |
| `wholesaler_total_amount` | 合計金額 |
| `wholesaler_invoice_id` | 大元の請求書ID（バージョン管理用。初回は NULL） |
| `wholesaler_invoice_csv_url` | CSV ファイルの Drive URL |
| `created_at` | 作成日時 |

### 4.2 store_invoices（加盟店請求書）
加盟店単位の請求書。`is_latest = TRUE` のレコードが有効。

| カラム | 説明 |
|--------|------|
| `id` | 主キー（UUID） |
| `wholesaler_invoice_id` | 紐づく wholesaler_invoices.id |
| `wholesaler_id` | 卸業者ID |
| `mall_code` | 加盟店コード |
| `backoffice_review_status` | バックオフィス審査ステータス |
| `invoice_status` | 請求ステータス（否認・取り下げ管理） |
| `is_latest` | 有効フラグ（最新版のみ TRUE） |

### 4.3 invoice_lines（請求明細行）
請求書の明細行データ。

## 5. ステータス定義

### 5.1 backoffice_review_status（バックオフィス審査ステータス）

| 値 | 表示名 | 説明 |
|----|--------|------|
| `PENDING_REVIEW` | 未検閲 | バックオフィス未処理 |
| `RETURNED` | 差戻し | バックオフィスが卸へ差し戻し |
| `MERCHANT_CONFIRMATION_REQUESTED` | 加盟店確認中 | 加盟店に確認依頼済み |
| `APPROVED` | 承認 | 加盟店承認済み |

### 5.2 invoice_status（請求ステータス）

| 値 | 表示名 | 説明 |
|----|--------|------|
| `DISPUTED` | 否認 | 加盟店が否認した状態 |
| `WITHDRAWN` | 取り下げ済 | 卸が取り下げた状態 |

### 5.3 wholesaler_status（卸ステータス）

| 値 | 説明 |
|----|------|
| `active` | 有効（通常利用可） |
| `end` | 終了（参照・再請求のみ可） |

### 5.4 store_status（加盟店ステータス）

| 値 | 説明 |
|----|------|
| `active` | 有効（新規請求対象） |
| `end` | 終了（新規請求対象外、既存請求は表示） |

### 5.5 一覧画面のステータスバッジ表示

| 条件 | バッジ | 説明 |
|------|--------|------|
| 差戻しあり（RETURNED） | 要再提出 | 1件以上の加盟店が差し戻し状態 |
| 否認あり（DISPUTED） | 否認 | 1件以上の加盟店が否認状態 |
| 上記なし | 未対応 | 特にアクション不要 |

## 6. 認証方式

### 6.1 Google 組織内ユーザー
- GAS の `Session.getActiveUser().getEmail()` でメールアドレスを取得。
- BigQuery の `wholesaler_users` テーブルと突合して卸業者IDを特定。

### 6.2 外部アカウント（Google 組織外）
- 専用ログインページ（LP）から Google OAuth でトークンを取得。
- GAS の `doPost` で tokeninfo を検証し、セッショントークンを発行。
- 以降のリクエストは CacheService に保存したセッショントークンで認証。
