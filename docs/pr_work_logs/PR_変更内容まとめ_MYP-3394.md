# PR 変更内容まとめ：MYP-3394 請求一覧表示・アカウント情報取得の実装

## 概要

バックオフィス API 経由だったデータ取得を **BigQuery 直接クエリ**に切り替え、
あわせてセキュリティ・UX・コード品質の改善を行った。

---

## 主な変更内容

### 1. バックエンド：BigQuery 直接取得への切り替え

#### `src/db_bq_connection.js`（新規）
- BQ へのクエリ実行基盤（`runQuery_`）を新設
- BQ Load Job 系ヘルパー（`loadCsvToBq_`・`waitForLoadJob_`・`runTransactionSql_` 等）を整備

#### `src/db_bq_query.js`（新規）
- `fetchAccountInfoByEmail_(email)` を新設
  - `wholesaler_user` を起点に `wholesalers` / `wholesaler_merchants` / `store` を JOIN し、アカウント情報 + 加盟店マッピングを一括取得
  - `csv_format_rules` の JSON.parse は try/catch で保護
- `fetchInvoicesByWholesaler_(wholesalerId)` を新設
  - 卸業者 ID に紐づく請求一覧を BQ から取得

#### `src/be_server.js`
- バックオフィス API 呼び出しコードを全廃し、BQ 取得に全面刷新
- `getServerAccountInfo_()` を内部ヘルパーとして追加
  - `Session.getActiveUser().getEmail()` でログインユーザーを特定し BQ クエリ
  - 未登録・削除済み・卸非アクティブの場合は `UNAUTHORIZED` エラーを throw
- 公開関数は `getAccountInfo()` のみ（フロントから `google.script.run` 経由で呼ぶ）

#### `src/be_invoice.js`
- `sendInvoiceData()` のアカウント情報取得を `getServerAccountInfo_()` 経由に変更
  - セキュリティ上、フロントから渡す `wholesaler_id` は使用しない
- `fetchInvoices()` を BQ 直接取得に変更
  - `wholesaler_id` はサーバー側で確定（セッション改ざんによる他卸データ取得を防止）
- Drive 保存先フォルダ名を `{wholesaler_id}_{wholesaler_name}` 形式に変更
- カレンダー表示用の `getMockScheduleData()` のみ残存（他のモック・スタブは全廃）

#### `src/be_config.js`
- `BACKOFFICE_API_POST_URL` / `BACKOFFICE_API_GET_URL` を廃止
- `GCP_PROJECT_ID` / `BQ_DATASET_ID` / `BQ_LOCATION` を Script Property として追加
- 個別プロパティ上書きヘルパー（`overwriteScriptProperty_` 等）を追加

---

### 2. フロントエンド：UX・セキュリティ改善

#### `src/fe_js.html`

**アカウント情報取得フロー改善**
- `DOMContentLoaded` 時に `showLoadingOverlay` → `getAccountInfo()` → 成功/失敗両方で `hideLoadingOverlay()` → `navigate()` の順に統一（レースコンディション解消）
- `getAccountInfo` 失敗時・GAS 環境外時は `location.hash = '#error'` に強制してから `navigate()` を呼ぶことで、エラーが必ず見える状態に

**セキュリティ**
- `fetchInvoices()` の呼び出し引数から `wholesaler_id` を削除（サーバー側で確定するため不要）

**状態管理**
- `resetPage()` に `homeInitialized = false` を追加（請求登録後にトップ画面へ戻った際に請求一覧を再取得）
- `initHomePage()` 冒頭に `shiire_wholesaler_id` の SessionStorage ガードを追加（アカウント未取得時は早期 return）

**ヘッダー企業名**
- `saveAccountInfo()` でヘッダーの `#headerWholesalerName` を動的更新
- 値が空・null の場合は `―` をフォールバック表示

**エラーハンドリング**
- `saveAccountInfo()` の SessionStorage 書き込みと DOM 更新の try/catch を分離（片方失敗でも他方を継続）
- ローカルフォールバックモック（GAS 環境外での擬似動作）を完全削除

**Toast**
- 成功時トーストは 4 秒後に自動非表示、エラー時は手動のみに統一

**確認画面**
- 加盟店名の参照キーを `merchant_name` → `store_name` に修正（キー不一致バグ修正）

---

### 3. エラーページ追加

#### `src/fe_page_error.html`（新規）
- アカウント未登録・システムエラー・GAS 環境外の 3 パターンに対応した専用エラーページ
- 「ログインページに戻る」リンク（クリックでページリロード）を設置

#### `src/fe_js.html`
- ルーティングに `'#error': 'pageError'` を追加
- `showErrorPage_(type)` を追加（`'unauthorized'` / `'system'` / `'env'` で文言切り替え）

#### `src/fe_css.html`
- エラーページ用スタイル（カード・バナー・連絡先・リンク）を追加

#### `src/fe_index.html`
- `fe_page_error` を include に追加

---

### 4. ヘッダー

#### `src/fe_part_header.html`
- 企業名表示用に `id="headerWholesalerName"` を持つ `<span>` を追加（初期値 `―`）

---

## セキュリティ上のポイント

| 項目 | 対応内容 |
|------|---------|
| `wholesaler_id` の改ざん対策 | フロントからの引数を使わず、サーバー側でセッションから確定 |
| 未登録ユーザーのアクセス制御 | `UNAUTHORIZED` エラーで即 throw、エラーページへ誘導 |
| メールアドレス漏洩対策 | `Session.getActiveUser().getEmail()` はサーバー側のみで使用 |

---

## スコープ外（今後の対応）

- `fetchInvoices()` が呼ぶ `getServerAccountInfo_()` の BQ クエリ最適化（軽量クエリへの分離 or CacheService）
  - PoC 規模（卸5社・月数回）では無料枠内のため今回は対応しない
- 未登録ユーザーを `doGet()` 側で弾く対応（C 案）
  - 本番移行時に検討
- 請求詳細画面（`fetchInvoiceDetail`）の実装
- カレンダーのモックデータ（`getMockScheduleData`）の本番データ化
