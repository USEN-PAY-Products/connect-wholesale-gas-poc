# 画面仕様書

仕入れコネクト（卸側）の画面別仕様書です。

## ドキュメント構成

| ファイル | 内容 |
|---------|------|
| [01_top_page.md](01_top_page.md) | Top画面（ホーム画面）仕様書 |
| [02_csv_upload_page.md](02_csv_upload_page.md) | CSVアップロード画面仕様書 |
| [03_confirm_page.md](03_confirm_page.md) | アップロード後の確認画面仕様書 |
| [04_detail_page.md](04_detail_page.md) | 詳細画面（登録済み請求内容）仕様書 |
| [05_common.md](05_common.md) | 共通仕様（ヘッダー、フッター、バリデーション、エラー等）|
| [06_user_guide.md](06_user_guide.md) | 📘 ユーザーガイド（PM / ディレクター向け）|
| [07_test_scenarios.md](07_test_scenarios.md) | 🧪 テストシナリオ集（QA / テスター向け）|

## システム概要

- **アプリケーション名**: 仕入れコネクト
- **基盤**: Google Apps Script（GAS）Webアプリ
- **フロントエンド**: HTML + Vanilla JS（SPA構成、ハッシュルーター）
- **バックエンド**: GAS サーバーサイド関数（`google.script.run` 経由）
- **データストア**: BigQuery
- **ファイルストレージ**: Google Drive

## 画面遷移図（全体）

```mermaid
flowchart TD
    LOGIN["GAS Webアプリ アクセス"] --> AUTH{"アカウント認証\ngetAccountInfo()"}
    AUTH -->|成功| HOME["Top画面\n#home"]
    AUTH -->|失敗| ERROR["エラー画面\n#error"]

    HOME -->|新規請求を登録する| UPLOAD["CSVアップロード画面\n#upload"]
    HOME -->|詳細を見る| DETAIL["詳細画面\n#detail?invoiceId=xxx"]
    HOME -->|請求スケジュール| CAL_MODAL["カレンダーモーダル"]
    HOME -->|ヘッダー卸名 → ログアウト| LOGOUT["LP へリダイレクト\ngetLogoutUrl()"]

    UPLOAD -->|契約終了/受付期間外| BLOCKED["受付期間バナー\n（アップロード不可）"]
    UPLOAD -->|確認画面へ進む| CONFIRM["確認画面\n#confirm"]
    UPLOAD -->|一覧に戻る| HOME

    CONFIRM -->|登録内容を送信する| HOME
    CONFIRM -->|一覧に戻る| HOME
    CONFIRM -->|キャンセル| UPLOAD

    DETAIL -->|一覧に戻る| HOME
    DETAIL -->|CSV一括アップロード| D_MODAL_BULK["アップロードモーダル\n（一括）"]
    DETAIL -->|修正ファイルをアップ| D_MODAL_SINGLE["アップロードモーダル\n（個別・モーダル内完結）"]
    DETAIL -->|変更なしで再請求| DETAIL
    DETAIL -->|請求取り下げ| DETAIL
    DETAIL -->|取下げをやめる| DETAIL

    D_MODAL_BULK -->|確認画面へ進む| CONFIRM
    D_MODAL_SINGLE -->|登録成功| DETAIL

    CAL_MODAL -->|閉じる| HOME
```

> 📌 ヘッダー右上の卸事業者名をクリックするとドロップダウンが開き、「ログアウト」で LP（`LP_URL`）へリダイレクトする（全画面共通）。詳細は [05_common.md](05_common.md#6-認証アカウント管理) を参照。

## 関連ファイル

| ディレクトリ | ファイル | 役割 |
|-------------|---------|------|
| `src/` | `fe_index.html` | エントリーポイント HTML |
| `src/` | `fe_part_header.html` | 共通ヘッダー |
| `src/` | `fe_page_home.html` | Top画面 HTML |
| `src/` | `fe_page_csv_upload.html` | アップロード画面 HTML |
| `src/` | `fe_page_confirm.html` | 確認画面 HTML |
| `src/` | `fe_page_detail.html` | 詳細画面 HTML |
| `src/` | `fe_page_error.html` | エラー画面 HTML |
| `src/` | `fe_css.html` | 全画面共通 CSS |
| `src/` | `fe_js_common.html` | 共通基盤（ルーター・トースト・ヘッダー/ログアウト・アカウント初期化） |
| `src/` | `fe_js_csv_common.html` | CSV 共通処理（`validateCsv` / `parseCsvLine` / `getCsvFormatRules`） |
| `src/` | `fe_js_calendar.html` | 請求スケジュールカレンダー（ホーム・詳細で共有） |
| `src/` | `fe_js_home.html` | ホーム画面ロジック |
| `src/` | `fe_js_upload.html` | CSVアップロード画面ロジック |
| `src/` | `fe_js_confirm.html` | 確認画面ロジック |
| `src/` | `fe_js_detail.html` | 詳細画面ロジック（再アップロードモーダル含む） |
| `src/` | `be_main.js` | GAS エントリーポイント |
| `src/` | `be_server.js` | アカウント情報取得 |
| `src/` | `be_invoice.js` | 請求データ関連 API |
| `src/` | `be_csv_mapper.js` | CSV動的マッピング |
| `src/` | `be_config.js` | 環境設定 |
| `src/` | `be_utils.js` | 共通ユーティリティ |
| `src/` | `db_bq_connection.js` | BigQuery 接続 |
| `src/` | `db_bq_query.js` | BigQuery クエリ関数 |
