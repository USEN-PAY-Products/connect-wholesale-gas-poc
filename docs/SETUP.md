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
5. **マージ・自動反映**: レビュー後、`develop` / `main` ブランチにマージされると、GitHub Actions が自動で対応する GAS プロジェクトへデプロイします。

## 3. Script Properties の設定（初回必須）

バックエンドの設定値（API URL / Drive フォルダID）はコードにハードコードせず、GAS の **Script Properties** で管理しています。
初回デプロイ後に以下の手順で一度だけ設定してください。

### 方法A: セットアップ関数を実行する（推奨）

> ⚠️ `be_config.js` 内の初期値はテスト用（`httpbin.org`）です。本番環境では実行前に値を書き換えてください。

**手順：**

1. GASエディタ（[script.google.com](https://script.google.com)）を開く
2. 左側のファイル一覧から **`be_config`** を開く
3. 関数のドロップダウン（▶ ボタンの左隣）から **`setupScriptProperties`** を選択
4. ▶ 実行ボタンをクリック
5. 画面下部の「実行ログ」に「Script Properties を設定しました。」と表示されれば完了

**すでに設定済みで値を上書きしたい場合・設定値の間違いや不足を修正したい場合：**

 以下のようなエラーが出た場合や、設定値（URL / フォルダID）を変更したい場合は、`be_config.js` の「設定値の書き込み」ブロック内の値を先に修正してから、以下の一時関数を追記して実行し、完了後に削除してください：

```
Error: [setupScriptProperties] Script Properties はすでに設定済みです（上書きをスキップしました）。
```

```javascript
function resetScriptProperties() {
  setupScriptProperties(true); // true を渡すことで既存値を強制上書き
}
```

1. `be_config.js` の設定値（URL / フォルダID）を修正
2. 上記の一時関数を `be_config.js` に追記して保存（Ctrl+S / Cmd+S）
3. ドロップダウンから **`resetScriptProperties`** を選択して ▶ 実行
4. 完了後にその関数は削除する

**設定内容の確認方法：**

現在の設定値を確認したい場合は、以下の一時関数を同様に追記・実行・削除してください：

```javascript
function checkScriptProperties() {
  const p = PropertiesService.getScriptProperties().getProperties();
  console.log(JSON.stringify(p, null, 2));
}
```

実行後、画面下部の「実行ログ」に設定済みのプロパティ一覧が表示されます。

### 方法B: GASエディタのUIから直接入力する

「プロジェクトの設定 → スクリプトプロパティ」から以下を登録します。

| プロパティ名 | 説明 |
|---|---|
| `BACKOFFICE_API_POST_URL` | 請求データ送信先エンドポイントURL |
| `BACKOFFICE_API_GET_URL` | 請求一覧・詳細取得エンドポイントURL |
| `DRIVE_ROOT_FOLDER_ID` | 監査証跡CSV保存先のDriveフォルダID |

### 認証 API（`src-auth/`）の Script Properties

認証 API は別 GAS プロジェクトとしてデプロイされます。
初回デプロイ後、GAS エディタで `setupAuthScriptProperties()` を実行してください。

| プロパティ名 | 説明 |
|---|---|
| `GCP_PROJECT_ID` | BigQuery の GCP プロジェクト ID（メインアプリと同じ） |
| `BQ_DATASET_ID` | BigQuery のデータセット ID（メインアプリと同じ） |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 クライアント ID |

### wholesaler_id について

`_getWholesalerId()` はログインユーザーのメールアドレスの **@より前の部分**（ローカルパート）を卸IDとして使用します。
例: `taro.yamada@example.com` → `taro.yamada`

これによりフォルダ名や外部APIのペイロードへの個人メールアドレス全文の漏洩を防いでいます。