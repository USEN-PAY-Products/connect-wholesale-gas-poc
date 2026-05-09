# 卸システム（Wholesaler System）ディレクトリ構成・開発フロー定義

## 1. 全体ディレクトリ構成

ローカル開発での体験（Live Serverでのプレビュー、Copilotの補完精度）を最大化するため、開発用の `src` ディレクトリと、GASへデプロイする `dist` ディレクトリを明確に分離します。

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
│       │   └── upload.html    # CSVアップロード画面
│       ├── css/
│       │   └── style.css      # スタイルシート
│       ├── images/
│       │   └── icon-company.svg  # 企業アイコン（インラインSVGとしてHTMLに埋め込み）
│       └── js/
│           └── app.js         # SPAルーター / CSV バリデーション / GAS送信処理
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
3. `js/app.js` を `<script>` タグとしてインライン化 → `dist/index.html` を出力
4. `appsscript.json` を `dist/appsscript.json` にコピー
5. `src/backend/` の `.js` ファイルすべてを `dist/` 直下にコピー（GASはフラット構成のため）

### Step 3: clasp push
`.clasp.json` の `rootDir` を `"dist"` に設定しておきます。
ターミナルで `clasp push` を実行すると、`dist/` の中身だけが綺麗にGASへデプロイされます。
