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
│   ├── 01_directory_structure.md
│   └── 02_system_requirements.md
└── src/                       # 🚀 開発 & デプロイ用（ここで作業 → そのまま GAS へ push）
    ├── appsscript.json        # GAS マニフェスト（権限・タイムゾーン設定）
    ├── be_main.js             # Back-end: エントリーポイント（doGet / include）
    ├── be_config.js           # Back-end: 環境設定（ScriptProperties の取得・初期設定）
    ├── be_utils.js            # Back-end: 共通ユーティリティ（レスポンス整形・Drive操作・日付変換）
    ├── be_invoice.js          # Back-end: 請求ドメイン（sendInvoiceData / fetchInvoices / fetchInvoiceDetail）
    ├── fe_index.html          # Front-end: SPA ルート HTML（GAS テンプレート）
    ├── fe_css.html            # Front-end: 共通スタイルシート（<style> タグ）
    ├── fe_js.html             # Front-end: クライアント JS 全結合（<script> タグ）
    ├── fe_part_header.html    # Front-end: 【パーツ】共通ヘッダー
    ├── fe_page_home.html      # Front-end: 【画面】ホーム
    ├── fe_page_csv_upload.html # Front-end: 【画面】CSV アップロード
    ├── fe_page_confirm.html   # Front-end: 【画面】確認画面
    └── fe_page_detail.html    # Front-end: 【画面】詳細画面
```

## 2. ファイル命名規則

| プレフィックス | 対象 | 内容 |
|---|---|---|
| `be_` | Back-end | サーバー側ロジック（`.js`） |
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
<?!= include('fe_js'); ?>
```


```text
wholesaler-system/
├── .clasp.json                # claspの設定ファイル（push先は dist/ を指定）
├── appsscript.json            # GASのタイムゾーンやスコープ設定
├── package.json               # Node.jsパッケージ（ビルドスクリプト管理用）
├── build.js                   # ビルドスクリプト（@@include展開 / CSS・JS インライン化）
├── docs/                      # ドキュメント群
│   ├── DESIGN.md              # 画面デザイン・スタイル定義
│   ├── SETUP.md               # 環境構築・開発マニュアル
│   ├── 01_directory_structure.md
│   ├── 02_system_requirements.md
│   └── CODING_RULES.md
├── src/                       # 🛠️ 開発用ディレクトリ（ここで作業する）
│   ├── backend/               # GASバックエンド（BE）
│   │   ├── config.js          # Script Properties 取得・初期設定ヘルパー
│   │   └── server.js          # doGet / BackOffice API プロキシ / Drive保存ロジック
│   └── frontend/              # 画面フロントエンド（FE）
│       ├── index.html         # SPAシェル（@@include でコンポーネントを結合）
│       ├── components/
│       │   └── header.html    # ヘッダーコンポーネント
│       ├── pages/
│       │   ├── home.html      # ホーム画面
│       │   ├── upload.html    # CSVアップロード画面
│       │   └── confirm.html   # 確認画面
│       ├── css/
│       │   └── style.css      # スタイルシート
│       ├── images/
│       │   └── icon-company.svg  # 企業アイコン（インラインSVGとしてHTMLに埋め込み）
│       └── js/
│           ├── utils.js       # 共通ユーティリティ（escapeHtml など）
│           ├── home.js        # ホーム画面（カレンダー・請求履歴描画）
│           ├── upload.js      # アップロード画面（CSV読み込み・バリデーション・状態管理）
│           ├── confirm.js     # 確認画面（モーダル・送信処理・テーブル描画）
│           └── router.js      # SPA ルーター（ハッシュ変化の検知・ページ切替）
└── dist/                      # 🚀 デプロイ用ディレクトリ（GASにpushされる）
    ├── appsscript.json        # ルートからコピー
    ├── index.html             # FEのHTML・CSS・JSが1つに結合されたファイル
    ├── config.js              # src/backend/config.js のコピー
    └── server.js              # src/backend/server.js のコピー
```

## 2. 開発フロー（The Vibe Coding Way）

### Step 1: ローカルでのUI開発 (Live Server)
`src/frontend/` 内で、ピュアな `.html`, `.css`, `.js` を記述します。
Copilotの補完がフルに効き、VSCodeの Live Server 機能を使ってブラウザで即座にUI・CSVパースの動作確認が可能です（GAS特有の遅延なし）。

### Step 2: ファイルの結合（ビルド）
開発が一段落し、GAS上で動かしたくなったら `dist/` ディレクトリへ統合します。
`node build.js`（または `npm run build`）を実行すると、以下が自動で行われます。

1. `src/frontend/index.html` の `<!-- @@include -->` ディレクティブを再帰展開
2. `css/style.css` を `<style>` タグとしてインライン化
3. `js/` 配下の JS ファイルを依存順（`utils → home → upload → confirm → router`）で結合し、`<script>` タグとしてインライン化 → `dist/index.html` を出力
4. `appsscript.json` を `dist/appsscript.json` にコピー
5. `src/backend/` の `.js` ファイルすべてを `dist/` 直下にコピー（GASはフラット構成のため）

### Step 3: clasp push
`.clasp.json` の `rootDir` を `"dist"` に設定しておきます。
ターミナルで `clasp push` を実行すると、`dist/` の中身だけが綺麗にGASへデプロイされます。
