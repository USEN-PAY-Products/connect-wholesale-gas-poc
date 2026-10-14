# 環境構築・開発マニュアル

本プロジェクトでは、Google公式ツール `clasp` を使用して、VS Code等のローカル環境で開発を行い、GitHubでコードを管理します。

## 1. 初回の環境構築手順

### ステップ1：GAS APIの有効化（必須）
1. ブラウザで [Google Apps Script ユーザー設定](https://script.google.com/home/usersettings) にアクセスします。
2. 開発に使用するGoogleアカウントでログインします。
3. 「Google Apps Script API」のトグルを **オン** にします。

### ステップ2：claspのインストールとログイン
ターミナルで以下のコマンドを実行します。（※事前にNode.jsのインストールが必要です）

```bash
# claspのインストール
npm install -g @google/clasp

# Googleアカウントへのログイン
clasp login
※ブラウザが立ち上がるので、アカウントへのアクセスを「許可」してください。
```
ステップ3：テスト用GASの作成と紐付け
リポジトリを手元にクローンした後、各自で「自分専用のテスト環境」を作成します。

```bash
# 1. リポジトリのクローン（URLは実際のプロジェクトのものに変更）
git clone <repository_url>
cd <project_dir>

# 2. テスト用GASプロジェクトの新規作成
clasp create --type standalone --title "【テスト用:自分の名前】AWS連携API"
```
⚠️ 注意
上記コマンドを実行すると .clasp.json というファイルが生成されます。これは個人のテスト環境と紐づくIDが書かれているため、絶対にGit（GitHub）にはプッシュしないでください。（初期設定で .gitignore に含まれているか確認してください）

## 2. 日々の開発フロー

1. **ブランチ作成**: `develop` ブランチから作業用のブランチを切ります。
2. **実装**: `src/` 内で VS Code と GitHub Copilot 等を使ってコーディングします。
3. **動作確認**:
   - ターミナルで `npm run push:dev` を実行し、自分のテスト用 GAS にコードを反映させます。
   - `clasp open` でブラウザのエディタを開き、実行ログやデプロイ後の挙動を確認します。
4. **PR 作成**: 動作OKなら GitHub へプッシュし、プルリクエストを作成します。
5. **マージ・コード反映**: レビュー後、`develop` / `main` ブランチにマージされると、GitHub Actions が対応する GAS プロジェクトへコードを push します。

### Web アプリのデプロイ更新

GitHub Actions の Web アプリデプロイ処理は一時停止中のため、`clasp push` だけでは既存 `/exec` URL の実行バージョンは更新されません。Web アプリの変更を利用者へ反映する場合は、GAS エディタから既存の Web アプリデプロイを編集し、新しいバージョンを選択して更新してください。既存デプロイを更新すれば URL は維持されます。更新前に dev で `?wholesalerId=<卸ID>#home` の動作とBackOfficeへの戻り導線を確認し、prd 反映は所定のリリース承認後に行ってください。

## 3. Script Properties の設定（初回必須）

卸システムは BackOffice 担当者が Google Workspace アカウントでログインし、卸を選択して操作します。初回デプロイ後、GAS エディタの「プロジェクトの設定 → スクリプト プロパティ」から、次の値を登録してください。設定変更用のトップレベル関数は用意していません。`executeAs: USER_DEPLOYING` の Web アプリでは、公開関数からスクリプトプロパティを書き換えられないようにするためです。

| プロパティ名 | 必須 | 内容 |
|---|---|---|
| `DRIVE_ROOT_FOLDER_ID` | はい | 監査証跡 CSV の保存先 Drive フォルダ ID |
| `GCP_PROJECT_ID` | はい | BigQuery の GCP プロジェクト ID |
| `BQ_DATASET_ID` | はい | BigQuery のデータセット ID（例: `connect_db`） |
| `BQ_LOCATION` | いいえ | BigQuery のリージョン（例: `asia-northeast1`。未設定時は `US`） |
| `ENV` | いいえ | 実行環境。開発環境では `development` を設定 |
| `ALLOWED_DOMAINS` | prd では必須運用 | 許可するメールドメインのカンマ区切り。未設定時は制限なし |
| `ALLOWED_EMAILS` | 任意 | 許可するメールアドレスのカンマ区切り。未設定時は制限なし |
| `BACKOFFICE_URL` | いいえ | ヘッダーから BackOffice へ戻るリンク。`https://script.google.com/.../exec` 形式のみ有効 |
| `WEB_APP_URL` | いいえ | 卸切替後に開く Web アプリ URL。local GAS の `/exec` URL を明示する場合に設定。未設定時は `ScriptApp.getService().getUrl()` を使用 |

許可リストはドメインとメールアドレスの両方を設定した場合、**両方の条件を満たすユーザーのみ**許可します。PoC 仕様上、両方未設定ならドメイン内を含む全ユーザーを許可するため、本番では `ALLOWED_DOMAINS` または `ALLOWED_EMAILS` の少なくとも一方を必ず設定してください。

## 4. 認証と卸の選択

Web アプリは `Session.getActiveUser().getEmail()` で操作者を識別し、`appsscript.json` の `webapp.access: DOMAIN` と上記の許可リストでアクセスを制限します。卸 ID はログイン情報から推測せず、BackOffice の「CSV 登録」リンク、または卸システムのヘッダーメニューで明示的に選択します。サーバーは各 API 呼び出しで卸の存在・状態を再検証します。

卸を切り替えるとページを再読み込みし、前の卸に紐づく `sessionStorage` のキャッシュを消去します。操作記録は操作者本人の `wholesaler_user` 行 ID と `store_invoices.final_updated_by` に保存し、メールアドレスは監査・エラーログ用途で使用します。