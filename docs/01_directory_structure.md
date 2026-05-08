# 卸システム（Wholesaler System）ディレクトリ構成・開発フロー定義

## 1. 全体ディレクトリ構成

ローカル開発での体験（Live Serverでのプレビュー、Copilotの補完精度）を最大化するため、開発用の `src` ディレクトリと、GASへデプロイする `dist` ディレクトリを明確に分離します。

```text
wholesaler-system/
├── .clasp.json                # claspの設定ファイル（push先は dist/ を指定）
├── appsscript.json            # GASのタイムゾーンやスコープ設定
├── package.json               # Node.jsパッケージ（ビルドスクリプト管理用）
├── docs/                      # ドキュメント群
│   ├── DESIGN.md              # 画面デザイン・スタイル定義
│   └── wholesaler_req.md      # システム要件定義書
├── src/                       # 🛠️ 開発用ディレクトリ（ここで作業する）
│   ├── backend/               # GASバックエンド（BE）
│   │   └── server.js          # doGetやBackOffice連携APIプロキシ
│   └── frontend/              # 画面フロントエンド（FE）
│       ├── index.html         # メインHTML（ガワ）
│       ├── css/
│       │   └── style.css      # ピュアなCSS
│       └── js/
│           ├── app.js         # 画面の表示切り替え、イベント制御
│           ├── csvParser.js   # CSV読み込み・パースロジック
│           └── api.js         # BE(google.script.run)との通信ラップ
└── dist/                      # 🚀 デプロイ用ディレクトリ（GASにpushされる）
    ├── index.html             # FEのhtml, css, jsが1つに結合されたファイル
    └── server.js              # BEのコード（push時に.gsとしてGASにアップされる）
```

## 2. 開発フロー（The Vibe Coding Way）

### Step 1: ローカルでのUI開発 (Live Server)
`src/frontend/` 内で、ピュアな `.html`, `.css`, `.js` を記述します。
Copilotの補完がフルに効き、VSCodeの Live Server 機能を使ってブラウザで即座にUI・CSVパースの動作確認が可能です（GAS特有の遅延なし）。

### Step 2: ファイルの結合（ビルド）
開発が一段落し、GAS上で動かしたくなったら `dist/` ディレクトリへ統合します。
`src/frontend/` の内容を1つの `dist/index.html` にまとめ、`src/backend/server.js` を `dist/server.js` にコピーします。

### Step 3: clasp push
`.clasp.json` の `rootDir` を `"dist"` に設定しておきます。
ターミナルで `clasp push` を実行すると、`dist/` の中身だけが綺麗にGASへデプロイされます。
