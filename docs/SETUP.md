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
ブランチ作成: main ブランチから作業用のブランチを切ります。

実装: VS CodeとGitHub Copilot等を使ってコーディングします。

動作確認:

ターミナルで clasp push を実行し、自分のテスト用GASにコードを反映させます。

clasp open でブラウザのエディタを開き、実行ログやデプロイ後のAPIの挙動を確認します。

PR作成: 動作OKならGitHubへプッシュし、プルリクエストを作成します。

マージ・自動反映: レビュー後、main ブランチにマージされると、GitHub Actionsが自動で「本番用GAS」にコードをデプロイします。