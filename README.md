# 卸システム（shiire-poc-supplier）PoC

本リポジトリは、卸業者が請求データ（CSV）をアップロードし、審査状況を確認するためのフロントエンド・インターフェース（Google Apps Script + HTML Service）です。

データの原本（DB）は持たず、BackOfficeシステムのAPIと連携する「Thin Client（BFF）」として機能します。

---

## 📁 ディレクトリ構成

開発体験とGASへのデプロイを両立するため、ソースコードは分割管理し、デプロイ時にビルド（結合）する構成をとっています。

```
/
├── src/          🛠️ 開発用ディレクトリ（ここでコーディングします）
│   ├── backend/      GASバックエンド（APIプロキシ）
│   └── frontend/     画面フロントエンド（HTML/CSS/JS）
├── dist/         🚀 デプロイ用ディレクトリ（ビルドによって自動生成され、GASへPushされます）
├── docs/         📄 設計書・仕様書・実装ロードマップ
└── build.js          ファイル結合用のNode.jsスクリプト
```

---

## 🚀 開発環境のセットアップ

Node.js と clasp (Google Apps Script CLI) が必要です。

```bash
# 1. パッケージと型定義のインストール
npm install

# 2. claspのグローバルインストール（未導入の場合のみ）
npm install -g @google/clasp

# 3. Googleアカウントでログイン
clasp login
```

### 環境（デプロイ先）の切り替え設定

本プロジェクトは `.clasp.json` をGit管理対象外としています。開発を始める前に、共有ドライブに作成したGASのスクリプトIDを使って設定ファイルを作成してください。

1. プロジェクトルートに `.clasp-dev.json` を作成：

    ```json
    {
      "scriptId": "あなたの開発用GASのスクリプトID",
      "rootDir": "./dist"
    }
    ```

2. （本番デプロイ時のみ）同様に `.clasp-prod.json` を作成。

---

## 💻 開発フロー（バイブコーディング仕様）

### 1. コーディング

`src/frontend/` 内の `index.html`、`style.css`、`app.js` を編集します。

> ※ VSCodeの Live Server 機能を使ってローカルでプレビューしながら開発するとスムーズです。

### 2. ビルド（ファイルの結合）

フロントエンドのファイルを1つの `index.html` に結合し、`dist/` フォルダに出力します。

```bash
npm run build
```

### 3. デプロイ（GASへPush）

```bash
# 開発環境（developブランチ）からデプロイする場合
npm run push:dev

# 本番環境（mainブランチ）からデプロイする場合
npm run push:prod
```

---

## 📚 ドキュメント

詳細な仕様やデザインガイドは `docs/` ディレクトリを参照してください。

- [UI/UX デザインガイドライン (DESIGN.md)](docs/DESIGN.md)
- [実装ステップ・プロンプトガイド](docs/plan/implementation_steps.md)