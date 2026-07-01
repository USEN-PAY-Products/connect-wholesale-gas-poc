# PR 作業まとめ: MYP-3691【卸】ログ出力実装

## 概要

GAS バックエンドの全公開関数・認証処理・CSV検証・BQクエリに対し、統一フォーマットのログ出力を追加した。  
ログはデバッグ・障害調査を目的とし、GAS 標準の `Logger.log` を使用する。

## 対象ブランチ

`feature/MYP-3691-add-logging` → `develop`

---

## 変更ファイル一覧

| ファイル | 変更種別 | 変更内容 |
|----------|---------|---------|
| `src/be_utils.js` | 追加 | ログユーティリティ関数 `logInfo_()` / `logError_()` / `sanitizeLogMessage_()` を追加 |
| `src/be_invoice.js` | 変更 | 全9公開関数に入口ログ・catchエラーログ追加。`sendInvoiceData` に各フェーズの所要時間ログ追加。`validateCsvHeader_` に検証結果ログ追加。staging DROP 失敗時のログを `logError_` に統一 |
| `src/be_server.js` | 変更 | `getServerAccountInfo_` に認証成功/失敗ログ追加。`getAccountInfo` の catch にエラーログ追加 |
| `src/be_csv_mapper.js` | 変更 | `validateCsvHeaderByRules_` に検証成功/失敗ログ追加 |
| `src/db_bq_query.js` | 変更 | `runQuery_` にクエリ実行時間（elapsed ms）ログ追加 |
| `docs/plan/logging_implementation_plan.md` | 追加 | ログ出力追加の実装計画書 |

---

## 設計方針

### ログレベル

`[INFO]` と `[ERROR]` の2段階。GAS の `Logger.log` は単一レベルのため、テキスト接頭辞で区別する。

### ログフォーマット

```
[レベル][タグ] メッセージ
```

例:
```
[INFO][Invoice] sendInvoiceData 開始: wholesaler_id=123, account_id=abc-def, merchantTotals_count=5
[ERROR][Auth] 認証失敗: アカウント情報が見つかりません
```

### ユーザー識別

- `account_id`（UUID）と `wholesaler_id` をログに含める
- メールアドレス等の PII はログに含めない
- `account_id` は UUID のため PII に該当せず、個人を一意に特定可能

### 安全対策（`sanitizeLogMessage_`）

- **改行エスケープ**: `\n` / `\r` → リテラル文字列に置換（ログ行分割によるログ汚染を防止）
- **長さ上限**: 1000文字超は切り詰めて `...(truncated)` を付与（ログ肥大化を防止）

### `logError_` のエラー型対応

`catch` で受け取る値の型に応じて適切に文字列化する:
- `Error` インスタンス → `error.message` + `error.stack`
- 文字列 → そのまま連結
- オブジェクト等 → `JSON.stringify`（循環参照時は `String()` にフォールバック）
- `null` / `undefined` → message のみ出力

---

## 変更詳細

### 1. ログユーティリティ（`be_utils.js`）

3関数を追加:

| 関数名 | 用途 |
|--------|------|
| `logInfo_(tag, message)` | INFO レベルのログ出力 |
| `logError_(tag, message, error)` | ERROR レベルのログ出力（error 引数は任意の型を受付） |
| `sanitizeLogMessage_(msg)` | 改行エスケープ + 1000文字上限トリム |

### 2. 公開関数の入口ログ（`be_invoice.js`）

以下の9関数の先頭で `logInfo_` を呼び、関数名・`wholesaler_id`・`account_id`・主要パラメータをログ出力:

| 関数名 | ログに含めるパラメータ |
|--------|----------------------|
| `sendInvoiceData` | `wholesaler_id`, `account_id`, `merchantTotals_count` |
| `resubmitInvoiceData` | `wholesaler_id`, `account_id`, `parentInvoiceId`, `storeInvoiceId` |
| `bulkResubmitInvoiceData` | `wholesaler_id`, `account_id`, `parentInvoiceId` |
| `resubmitWithoutChanges` | `wholesaler_id`, `account_id`, `storeInvoiceId`, `parentInvoiceId` |
| `withdrawStoreInvoice` | `wholesaler_id`, `account_id`, `storeInvoiceId`, `parentInvoiceId` |
| `fetchInvoices` | `wholesaler_id`, `account_id`, 取得件数 |
| `fetchInvoiceDetail` | `wholesaler_id`, `account_id`, `invoiceId`, `stores_count` |
| `getInvoiceLinesByStore` | `wholesaler_id`, `account_id`, `storeInvoiceId`, 取得件数 |
| `fetchScheduleData` | `wholesaler_id`, `account_id`, 取得件数 |

### 3. catch ブロックのエラーログ（`be_invoice.js`）

上記9関数 + staging DROP の catch 内（計12箇所）で `logError_` を呼び、エラーメッセージ・スタックトレースを記録。

**変更前**: `throw` のみ（エラー詳細が消失）  
**変更後**: `logError_` → `throw`（ログに残してから再 throw）

### 4. 認証ログ（`be_server.js`）

| 箇所 | ログ内容 |
|------|---------|
| `getServerAccountInfo_` 成功時 | `[INFO][Auth] 認証成功: wholesaler_id=X, account_id=Y` |
| `getServerAccountInfo_` 失敗時（メール取得不可） | `[ERROR][Auth] 認証失敗: メールアドレスを取得できませんでした` |
| `getServerAccountInfo_` 失敗時（アカウント不存在） | `[ERROR][Auth] 認証失敗: アカウント情報が見つかりません` |
| `getAccountInfo` catch | `[ERROR][Auth] getAccountInfo: {error詳細}` |

### 5. CSV 検証ログ（`be_csv_mapper.js` / `be_invoice.js`）

| 関数 | 成功時 | 失敗時 |
|------|--------|--------|
| `validateCsvHeaderByRules_` | `[INFO][CsvMapper] format=dynamic, columns=N, OK` | `[ERROR][CsvMapper] format=dynamic, columns=N, エラーM件` |
| `validateCsvHeader_` | `[INFO][Invoice] format=default, columns=N, OK` | `[ERROR][Invoice] format=default, 列数不正 or 列名不正の詳細` |

### 6. BQ クエリ実行時間ログ（`db_bq_query.js`）

`runQuery_` の完了時に取得行数と elapsed ms を出力:
```
[INFO][BQ] runQuery_ 完了: 取得行数=100, elapsed=1234ms
```

### 7. `sendInvoiceData` の所要時間ログ（`be_invoice.js`）

各フェーズの所要時間を個別にログ出力（GAS 6分実行制限の監視用）:

| フェーズ | ログ例 |
|----------|--------|
| Drive 保存 | `sendInvoiceData Drive保存完了: 850ms` |
| BQ Load Job | `sendInvoiceData Load Job完了: 3200ms` |
| トランザクション SQL | `sendInvoiceData トランザクション完了: 1500ms` |
| staging DROP | `sendInvoiceData staging DROP完了: 200ms` |
| 全体 | `sendInvoiceData 完了: invoiceUuid=X, total=5750ms` |

---

## コーディングルール準拠

| ルール | 対応 |
|--------|------|
| `var` 禁止 → `const` / `let` 使用 | ✅ 全箇所 `const` を使用 |
| 内部関数は末尾 `_` | ✅ `logInfo_` / `logError_` / `sanitizeLogMessage_` |
| `function` キーワードで定義 | ✅ アロー関数未使用 |

---

## 影響範囲

- **機能影響**: なし（ログ出力の追加のみ。既存の処理フロー・レスポンスに変更なし）
- **パフォーマンス影響**: `Logger.log` のオーバーヘッドは無視できるレベル。`Date.now()` による計測も軽量
- **既存ログとの関係**: `db_bq_connection.js` の既存 `Logger.log`（Load Job ポーリング等）はそのまま維持。今回追加分のみ `logInfo_` / `logError_` を使用
