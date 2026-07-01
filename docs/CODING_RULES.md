# コーディング規約 (GAS & SPA コンテキスト用)

このプロジェクトにおけるGASおよびフロントエンドの実装ルールです。GitHub CopilotなどのAIエディタは、GAS特有の仕様（V8エンジン）とSPA構成を理解した上でコードを生成してください。

---

## 0. ファイル構成・命名規則

本プロジェクトは **ビルドステップなし** で `src/` 配下を直接 GAS へデプロイします（`clasp push`）。
GAS のファイル管理はフラット構造のため、`src/` 直下に以下のプレフィックスルールでファイルを配置します。

### ディレクトリ構成

```
src/
├── appsscript.json          # GASマニフェスト（権限・タイムゾーン設定）
├── be_main.js               # Back-end: エントリーポイント（doGet, doPost, include）
├── be_auth.js               # Back-end: 外部アカウント認証（doPost, tokeninfo検証, セッショントークン発行）
├── be_assets.js             # Back-end: 静的アセット管理（favicon URL取得）
├── be_config.js             # Back-end: 環境設定（ScriptPropertiesの取得・管理）
├── be_csv_mapper.js         # Back-end: CSV列マッピング（csv_format_rules対応のSQL生成・ヘッダー検証）
├── be_invoice.js            # Back-end: 請求ドメイン（送信・再送信・取下げ・一括再送信）
├── be_server.js             # Back-end: アカウント情報取得・ログイン/ログアウトURL生成
├── be_utils.js              # Back-end: 共通ユーティリティ（レスポンス整形・Drive操作・日付フォーマット・ロギング）
├── db_bq_connection.js      # DB: BQ Load Job投入・ポーリング・トランザクション実行・staging DROP
├── db_bq_query.js           # DB: BQ 参照系クエリ（請求一覧・詳細・アカウント情報）
├── fe_index.html            # Front-end: SPAのルートHTML（GASテンプレート）
├── fe_css.html              # Front-end: 共通スタイルシート（styleタグ）
├── fe_js_common.html        # Front-end: 共通基盤（ルーター・トースト・ローディング・ヘッダー/ログアウト・アカウント初期化）
├── fe_js_csv_common.html    # Front-end: CSV共通処理（validateCsv / parseCsvLine / getCsvFormatRules）
├── fe_js_calendar.html      # Front-end: 請求スケジュールカレンダー（ホーム・詳細で共有）
├── fe_js_home.html          # Front-end: 【画面】ホームのJSロジック
├── fe_js_upload.html        # Front-end: 【画面】CSVアップロードのJSロジック
├── fe_js_confirm.html       # Front-end: 【画面】確認画面のJSロジック
├── fe_js_detail.html        # Front-end: 【画面】詳細画面のJSロジック（再アップロードモーダル含む）
├── fe_part_header.html      # Front-end: 【パーツ】共通ヘッダー
├── fe_page_home.html        # Front-end: 【画面】ホーム
├── fe_page_csv_upload.html  # Front-end: 【画面】CSVアップロード
├── fe_page_confirm.html     # Front-end: 【画面】確認画面
├── fe_page_detail.html      # Front-end: 【画面】詳細画面
└── fe_page_error.html       # Front-end: 【画面】エラーページ（認証エラー等）
```

### ファイル命名プレフィックス

| プレフィックス | 対象 | 内容 |
|---|---|---|
| `db_` | DB層 | DBアクセス・クエリ実行などのデータアクセス層（`.js`） |
| `be_` | Back-end | 画面遷移/API/業務ロジックなどのバックエンド層（`.js`） |
| `fe_` | Front-end | ブラウザ側UI・CSS・JS（`.html`） |
| `fe_page_` | 画面単位 | 特定ページのコンテンツ（`fe_page_xxx.html`） |
| `fe_part_` | 部品単位 | 複数画面で共有するパーツ（`fe_part_xxx.html`） |

### GASへの include 構文

`fe_index.html` から他の `fe_` ファイルを読み込む際は、GAS の `include()` 関数を使用します（拡張子なしで指定）。

`be_main.js` に以下の関数が定義されていること:

```javascript
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
```

### バックエンドのファイル分割方針

バックエンドは **責務（ドメイン）単位** でファイルを分割します。ページ単位では分けません。

| ファイル | 責務 |
|---|---|
| `db_bq_connection.js` | BQ Load Job投入・ポーリング・トランザクション実行・staging DROP |
| `db_bq_query.js` | BQ 参照系クエリ（請求一覧・詳細・アカウント情報） |
| `db_xxx.js` | 新しいDBアクセス処理を追加する際は `db_` を冠した新ファイルを作成する |
| `be_main.js` | エントリーポイントのみ。`doGet` と `include` だけを置く |
| `be_auth.js` | 外部アカウント認証（doPost, tokeninfo検証, セッショントークン発行・検証） |
| `be_assets.js` | 静的アセット管理（favicon URL取得等） |
| `be_config.js` | ScriptProperties の取得・初期設定のみ |
| `be_csv_mapper.js` | CSV列マッピング（csv_format_rules対応のSQL生成・ヘッダー検証） |
| `be_invoice.js` | 請求ドメインのロジック（sendInvoiceData, resubmit系, withdraw系, fetch系） |
| `be_server.js` | アカウント情報取得・ログイン/ログアウトURL生成 |
| `be_utils.js` | 全ファイルから使う汎用ヘルパー（レスポンス整形・Drive操作・日付変換・ロギングなど） |
| `be_xxx.js` | 新機能を追加する際は **機能名（ドメイン名）** を冠した新ファイルを作成する |

### フロントエンドのファイル分割方針

フロントエンドの JS は **画面（ページ）単位** で分割します。複数画面で共有する処理は共通ファイルに置きます。
各 JS ファイルは `fe_index.html` から include して結合されます（それぞれ独自の `<script>` タグで囲むこと）。

| ファイル | 責務 |
|---|---|
| `fe_js_common.html` | 全画面共通: ハッシュルーター・トースト・ローディング・`escapeHtml`・ヘッダー/ログアウト・アカウント情報取得（DOMContentLoaded 初期化） |
| `fe_js_csv_common.html` | CSV 共通処理: `validateCsv` / `parseCsvLine` / `getCsvFormatRules` / エンコード変換（アップロード・詳細の両画面が利用） |
| `fe_js_calendar.html` | 請求スケジュールカレンダー（ホーム・詳細で共有） |
| `fe_js_home.html` | ホーム画面のロジック（請求履歴一覧） |
| `fe_js_upload.html` | CSVアップロード画面のロジック |
| `fe_js_confirm.html` | 確認画面のロジック |
| `fe_js_detail.html` | 詳細画面のロジック（修正ファイル再アップロードモーダル含む） |

> ⚠️ GAS は include した全 JS を1つのグローバルスコープに連結します。トップレベルの `const` / `let` をファイル間で重複宣言すると `Identifier already declared` で全停止するため、**同名のグローバル変数・関数は1ファイルにのみ定義**すること。複数画面から使う処理は共通ファイル（`fe_js_common.html` 等）へ集約します。

### ファイル追加ルール

- **DBアクセス処理を追加する**: 既存の `db_` ファイルに追記する。新しいDBアクセス層が必要な場合は `db_yyy.js` を新規作成する。
- **バックエンドのロジックを追加する**: 責務に対応する既存の `be_` ファイルに追記する。新しいドメイン（例: 支払い・店舗管理など）が生まれた場合は `be_yyy.js` を新規作成する。
- **新しい画面を追加する**: `fe_page_xxx.html` を新規作成し、`fe_index.html` に include タグを追加する。
- **新しいパーツを追加する**: `fe_part_xxx.html` を新規作成し、必要な箇所で include する。
- **CSSを追加する**: `fe_css.html` の style ブロック内に追記する。
- **JSを追加する**: 対象の画面・責務に対応する `fe_js_xxx.html`（例: ホームなら `fe_js_home.html`、共通処理なら `fe_js_common.html`）の script ブロック内に追記する。新しい画面を追加した場合は `fe_js_xxx.html` を新規作成し、`fe_index.html` で include する。複数画面で共有する処理は `fe_js_common.html` / `fe_js_csv_common.html` / `fe_js_calendar.html` に置く。

---

## 1. 基本方針（モダンJSの活用）

- **変数宣言**: 基本的に `var` は使用せず、`const` と `let` を使用すること。
  - *(※ただし、GASのバックエンドで複数ファイル間でグローバル変数を共有する必要があるごくまれなケースにおいてのみ、`var` の使用を許容する)*
- **分割代入とスプレッド構文**: 配列やオブジェクトの操作には積極的に活用し、可読性を上げること。

---

## 2. 【重要】GAS関数定義の厳格なルール

GASとフロントエンド（`google.script.run`）を連携させるため、以下の関数定義ルールを厳守すること。

- **公開関数（エントリーポイント）**:
  - フロントから呼び出される関数や、`doGet`, `doPost` などは、**絶対にアロー関数を使用せず、`function` キーワードで定義**すること。（例: `function sendInvoiceData(data) {}`）
  - これらの関数名には、**絶対に末尾にアンダースコア（`_`）をつけない**こと。
- **内部関数（プライベート）**:
  - バックエンド内でのみ使用され、フロントから直接呼ばれない関数（例: ドライブ保存処理など）は、GAS上で隠蔽するために**名前の末尾にアンダースコア（`_`）をつける**こと。（例: `function saveToDrive_() {}`）
  - ローカルスコープ内でのコールバックや一時的な処理にはアロー関数を使用してよい。

---

## 3. GAS特有のパフォーマンス最適化

- **スプレッドシートの操作**:
  - ループ処理の中で `getValue()` や `setValue()` を絶対に実行しないこと（処理速度が著しく低下するため）。
  - 必ず `getValues()` を使って二次元配列としてデータを一括で取得し、メモリ上で計算・加工を行ってから、最後に `setValues()` で一括書き込みをすること。
- **実行時間制限の考慮**:
  - GASの「1回の実行は6分まで」という制限を考慮し、バルク処理（一括処理）を前提とした設計にすること。

---

## 4. エラーハンドリングと通信

- **バックエンドの受け口**: フロントからの呼び出しを受ける関数では必ず `try-catch` ブロックを使用すること。
- **エラー時の返却**: エラーが発生した場合は、フロントエンドの `withFailureHandler` で適切に捕捉できるよう、`throw new Error('エラーメッセージ')` の形で明示的にエラーを投げること。
- **`google.script.run` には必ず `.withFailureHandler()` を設定**し、ユーザーにエラー内容が伝わるようにすること。

---

## 5. デプロイ

ビルドは不要です。以下のコマンドで直接 GAS にデプロイします。

```bash
# 開発環境へデプロイ
npm run push:dev

# 本番環境へデプロイ
npm run push:prod
```

`push:dev` / `push:prod` は、対応する `.clasp-dev.json` / `.clasp-prod.json` を `.clasp.json` にコピーしてから `clasp push` を実行します（`rootDir: "./src"` が設定済み）。
