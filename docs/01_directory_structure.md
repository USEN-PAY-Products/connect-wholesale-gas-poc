# 卸システム（Wholesaler System）ディレクトリ構成・開発フロー定義

## 1. 全体ディレクトリ構成

`src/` 配下を直接 GAS へデプロイします（ビルドステップなし）。
GAS はファイル管理がフラット構造のため、`src/` 直下に `be_` / `fe_` プレフィックスのルールでファイルを配置します。

```text
shiire-poc-supplier/
├── .clasp.json                # clasp の設定ファイル（rootDir: "./src" を指定）
├── .clasp-dev.json            # 開発環境用 clasp 設定（push:dev で使用）
├── .clasp-prod.json           # 本番環境用 clasp 設定（push:prod で使用）
├── .clasp-local.json          # 個人ローカル検証用 clasp 設定
├── .claspignore               # GAS へ送らないファイルの除外定義
├── package.json               # npm 設定（clasp / 型定義パッケージ管理）
├── docs/                      # ドキュメント群
│   ├── DESIGN.md              # 画面デザイン・スタイル定義
│   ├── SETUP.md               # 環境構築・開発マニュアル
│   ├── CODING_RULES.md        # コーディング規約
│   ├── 01_directory_structure.md  # 本ファイル（ディレクトリ構成）
│   ├── 02_system_requirements.md  # 要件・設計定義
│   ├── plan/                  # 機能設計書
│   ├── pr_work_logs/          # PR 作業ログ
│   └── specifications/        # 仕様書
└── src/                       # 🚀 開発 & デプロイ用（ここで作業 → そのまま GAS へ push）
    ├── appsscript.json        # GAS マニフェスト（権限・タイムゾーン設定）
    ├── be_main.js             # Back-end: エントリーポイント（doGet / doPost / include）
    ├── be_auth.js             # Back-end: 外部アカウント認証（tokeninfo検証・セッショントークン発行）
    ├── be_assets.js           # Back-end: 静的アセット管理（favicon URL取得）
    ├── be_config.js           # Back-end: 環境設定（ScriptProperties の取得・初期設定）
    ├── be_csv_mapper.js       # Back-end: CSV列マッピング（csv_format_rules対応のSQL生成）
    ├── be_invoice.js          # Back-end: 請求ドメイン（送信・再送信・取下げ・一括再送信）
    ├── be_server.js           # Back-end: アカウント情報取得・ログイン/ログアウトURL生成
    ├── be_utils.js            # Back-end: 共通ユーティリティ（レスポンス整形・Drive操作・日付変換・ロギング）
    ├── db_bq_connection.js    # DB: BQ接続（Load Job投入・ポーリング・トランザクション実行・staging DROP）
    ├── db_bq_query.js         # DB: BQ参照系クエリ（請求一覧・詳細・アカウント情報）
    ├── fe_index.html          # Front-end: SPA ルート HTML（GAS テンプレート）
    ├── fe_css.html            # Front-end: 共通スタイルシート（<style> タグ）
    ├── fe_js_common.html      # Front-end: 共通基盤（ルーター・トースト・ヘッダー/ログアウト・アカウント初期化）
    ├── fe_js_csv_common.html  # Front-end: CSV 共通処理（validateCsv / parseCsvLine / getCsvFormatRules）
    ├── fe_js_calendar.html    # Front-end: カレンダー（ホーム・詳細で共有）
    ├── fe_js_home.html        # Front-end: ホーム画面ロジック
    ├── fe_js_upload.html      # Front-end: CSVアップロード画面ロジック
    ├── fe_js_confirm.html     # Front-end: 確認画面ロジック
    ├── fe_js_detail.html      # Front-end: 詳細画面ロジック（再アップロードモーダル含む）
    ├── fe_part_header.html    # Front-end: 【パーツ】共通ヘッダー
    ├── fe_page_home.html      # Front-end: 【画面】ホーム
    ├── fe_page_csv_upload.html # Front-end: 【画面】CSV アップロード
    ├── fe_page_confirm.html   # Front-end: 【画面】確認画面
    ├── fe_page_detail.html    # Front-end: 【画面】詳細画面
    └── fe_page_error.html     # Front-end: 【画面】エラーページ（認証エラー等）
```

## 2. ファイル命名規則

| プレフィックス | 対象 | 内容 |
|---|---|---|
| `db_` | DB層 | DBアクセス・クエリ実行（`.js`） |
| `be_` | Back-end | 画面遷移/API/業務ロジック（`.js`） |
| `fe_` | Front-end | ブラウザ側 UI・CSS・JS（`.html`） |
| `fe_page_` | 画面単位 | 特定ページのコンテンツ |
| `fe_part_` | 部品単位 | 複数画面で共有するパーツ |

## 3. 開発フロー

### Step 1: ローカルでの実装
`src/` 内でコーディングします。
Copilot の補完がフルに効き、型定義（`@types/google-apps-script`）による補完も利用できます。

### Step 2: GAS への反映（clasp push）

```bash
# 個人テスト環境へ push
npm run push:dev   # → .clasp-dev.json の scriptId へデプロイ

# 本番環境へ push
npm run push:prod  # → .clasp-prod.json の scriptId へデプロイ
```

各コマンドは対応する `.clasp-*.json` を `.clasp.json` にコピーしてから `clasp push` を実行します。
claspは `rootDir: "./src"` を参照するため、`src/` 内のファイルのみが GAS へ送信されます。

### Step 3: CI/CD による自動デプロイ
`develop` / `main` ブランチへのマージ時、GitHub Actions が自動で対応する GAS プロジェクトへデプロイします。
詳細は `.github/workflows/deploy.yml` を参照してください。

## 4. GAS テンプレートの include 構文

`fe_index.html` 内では GAS の `include()` ヘルパーで他ファイルを埋め込みます。
`be_main.js` に定義された `include(filename)` 関数が HTML ファイルを文字列として読み込みます（拡張子なしで指定）。

```html
<?!= include('fe_css'); ?>
<?!= include('fe_part_header'); ?>
<?!= include('fe_page_home'); ?>
<?!= include('fe_js_common'); ?>
<?!= include('fe_js_csv_common'); ?>
<?!= include('fe_js_calendar'); ?>
<?!= include('fe_js_home'); ?>
<?!= include('fe_js_upload'); ?>
<?!= include('fe_js_confirm'); ?>
<?!= include('fe_js_detail'); ?>
```



