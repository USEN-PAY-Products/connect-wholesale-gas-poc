# `validateTaxAdjustment_` 税額±1円サーバーサイド検証 — 実装詳細

## 1. 経緯

PR レビューで「GAS 上で CSV をパースしている点が既存の設計コメントと矛盾する」と指摘を受け、一度 BQ staging 集計方式に変更したが、以下の理由で **GAS パース方式に戻した**。

- 設計コメント中の TODO（「本番実装時は BQ で staging を再集計」）は、**本番環境（Kotlin+React+Postgres）** への移行時の方針であり、POC（GAS+BQ）の設計指針ではなかった
- POC の現在のデータ量（数十〜数百行）では GAS の 6分制限・メモリ制限に抵触しない
- 本番では BQ を使わず Postgres になる予定のため、BQ 集計方式を作り込む意味が薄い

**結論：POC では GAS 上で CSV をパースして検証する方式で実装。**

---

## 2. 方式概要

```
フロント（確認画面）
  ├─ リアルタイム ±1円バリデーション（入力時）
  └─ 送信時ブロック（±1円超ならボタン無効化）

バックエンド（be_invoice.js）
  ├─ ヘッダー検証（列数・列名チェック）
  ├─ validateTaxAdjustment_()  ← CSV テキストを GAS 上でパースして税額集計・比較
  ├─ Load Job → staging テーブルへ投入
  ├─ BEGIN TRANSACTION → INSERT
  └─ staging DROP
```

フロントの検証はユーザー体験向け、バックエンドの検証は改ざん防止のサーバーサイド防御。

---

## 3. 関数シグネチャ

```javascript
function validateTaxAdjustment_(csvText, summaryData, csvFormatRules, roundingMethod)
```

| パラメータ | 型 | 説明 |
|---|---|---|
| `csvText` | `string` | UTF-8 CSV テキスト全体 |
| `summaryData` | `Object` | `{ merchantTotals: [...] }` フロント確定値 |
| `csvFormatRules` | `Object\|null` | `accountInfo.csv_format_rules`（null = デフォルト卸） |
| `roundingMethod` | `string` | `'floor'` / `'ceil'` / `'round'` |

---

## 4. 処理フロー

```
1. csvText を改行で split
2. csv_format_rules からカラムインデックスを特定
   - デフォルト卸: 固定位置（ccIdx=0, amtIdx=6, rateIdx=5, taxIdx=7）
   - 新形式: columns 配列の system_column / field から動的解決
3. 必須カラム欠如チェック（customer_code, amount_ex_tax, tax_rate）
   → 不足時は throw
4. 全データ行を parseCsvLine_() でループ
   - customer_code × tax_rate で税額を集計（expected オブジェクト）
   - CSV に tax_amount 列があればその値を使用、なければ計算
   - NaN ガード: 数値不正行は行番号付きエラーで throw
   - taxRate === 10 → tax10 に加算 / taxRate === 8 → tax8 に加算（それ以外は除外）
5. summaryData.merchantTotals と expected を比較
   - CSV に存在しない customerCode → エラー
   - |submitted - expected| > 1 → エラー
6. エラーがあれば throw（先頭のエラーメッセージを返す）
```

---

## 5. 呼び出し位置

3つのエントリーポイントすべてで、**ヘッダー検証の直後・Load Job の前**に実行。

### sendInvoiceData（初回送信）

```
② ヘッダー検証
② validateTaxAdjustment_()
③ Load Job 投入
④ waitForLoadJob_()
⑤ BEGIN TRANSACTION
⑥ staging DROP
```

### resubmitInvoiceData（個別再送信）

```
ヘッダー検証
validateTaxAdjustment_()
Load Job 投入 → waitForLoadJob_()
fetchLatestWholesalerInvoice_()
BEGIN TRANSACTION
staging DROP
```

### bulkResubmitInvoiceData（一括再送信）

```
ヘッダー検証
validateTaxAdjustment_()
Load Job 投入 → waitForLoadJob_()
fetchLatestWholesalerInvoice_()
BEGIN TRANSACTION
staging DROP
```

---

## 6. エラーハンドリング

| ケース | 処理 |
|---|---|
| 必須カラム未定義（customer_code / amount_ex_tax / tax_rate） | `throw new Error(...)` 欠損カラム名を列挙 |
| CSV 行の数値フィールドが NaN | `throw new Error(...)` 行番号・フィールド値を含む |
| summaryData に CSV 上に無い customerCode がある | `errors.push(...)` → 最終 throw |
| 税額差が ±1円超 | `errors.push(...)` → 最終 throw（送信値・計算値を含む） |

---

## 7. 税率分岐のルール

```javascript
if (taxRate === 10)     expected[cc].tax10 += taxAmount;
else if (taxRate === 8) expected[cc].tax8  += taxAmount;
// 0% やその他の税率は tax10/tax8 のどちらにも加算しない
```

フロント側（確認画面・詳細モーダル）の集計ロジックも同一の分岐に統一済み。

---

## 8. 登録データへの影響

**なし。** `validateTaxAdjustment_` は検証のみで、登録データには一切関与しない。

| テーブル | データソース | 変更有無 |
|---|---|---|
| `wholesaler_invoices` | `summaryData.wholesalerTotal`（フロント確定値） | ❌ 変更なし |
| `store_invoices` | `summaryData.merchantTotals`（フロント確定値） | ❌ 変更なし |
| `invoice_lines` | staging テーブルから `INSERT SELECT`（CSV データそのまま） | ❌ 変更なし |

---

## 9. 設計コメントの更新内容

sendInvoiceData の JSDoc を以下のように更新：

- **フロー②** を「ヘッダー検証 + 税額±1円バリデーション（validateTaxAdjustment_）」に変更
- **セキュリティ欄** に「税額は CSV テキストから GAS 上で再集計し、±1円超で エラー」を追加
- **TODO** を「本番（Kotlin+React+Postgres）移行時に DB 側集計に切り替える。POC では GAS パース方式」に更新

---

## 10. FE（フロント）への影響

**なし。** フロント側の ±1円バリデーション（リアルタイム入力チェック + 送信時ブロック）はそのまま。サーバー側は二重防御として独立して動作する。
