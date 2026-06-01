# 卸システム（shiire-poc-supplier）PoC

本リポジトリは、卸業者が請求データ（CSV）をアップロードし、審査状況を確認するためのフロントエンド・インターフェース（Google Apps Script + HTML Service）です。

データの原本（DB）は持たず、BackOfficeシステムのAPIと連携する「Thin Client（BFF）」として機能します。

---

## 📁 ディレクトリ構成

```
/
├── src/          🛠️ メインアプリ（GAS Webアプリ、access=DOMAIN）
│   ├── be_*.js       バックエンド（サーバー側ロジック）
│   ├── db_*.js       DB層（BigQuery クエリ・接続）
│   ├── fe_*.html     フロントエンド（HTML/CSS/JS）
│   └── login.html    AWS ホスティング用ログインページ（GASには push されない）
├── src-auth/     🔐 認証 API（別 GAS プロジェクト、access=ANYONE_ANONYMOUS）
│   ├── auth.js       トークン検証・ BQ アカウント照合
│   └── appsscript.json
├── docs/         📄 設計書・仕様書
└── .github/      CI/CD（GitHub Actions）
```

### 2つの GAS プロジェクト構成

| | メインアプリ（`src/`） | 認証 API（`src-auth/`） |
|---|---|---|
| **access** | `DOMAIN` | `ANYONE_ANONYMOUS` |
| **用途** | CSVアップロード・請求管理 | AWS login.html からのトークン検証 |
| **ユーザー特定** | `Session.getActiveUser()` | Google ID トークン検証 |
| **clasp 設定** | `.clasp-local.json` 等 | `.clasp-auth-local.json` |

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

---

## 💻 開発フロー

### メインアプリ（`src/`）

```bash
# ローカルテスト環境へ push
npm run push:local

# 開発環境へ push
npm run push:dev

# 本番環境へ push
npm run push:prod
```

### 認証 API（`src-auth/`）

```bash
# ローカルテスト環境へ push
npm run push:auth-local

# デプロイ（push + deploy）
npm run deploy:auth-local
```

> 認証 API は初回デプロイ後、GAS エディタで `setupAuthScriptProperties()` を実行してスクリプトプロパティを設定してください。

---

## 📚 ドキュメント

詳細な仕様やデザインガイドは `docs/` ディレクトリを参照してください。

- [ディレクトリ構成](docs/01_directory_structure.md)
- [システム要件](docs/02_system_requirements.md)
- [コーディング規約](docs/CODING_RULES.md)
- [環境構築マニュアル](docs/SETUP.md)
- [UI/UX デザインガイドライン (DESIGN.md)](docs/DESIGN.md)