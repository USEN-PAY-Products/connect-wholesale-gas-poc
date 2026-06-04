# 詳細画面のステータス別表示 現状実装まとめ

## ステータスの種類

`store_invoices.backoffice_review_status` と `store_invoices.invoice_status` の組み合わせで以下の5パターンが存在する。

| backoffice_review_status | invoice_status | 表示ラベル | バッジCSSクラス |
|---|---|---|---|
| `PENDING_REVIEW` | ― | 未検閲 | `badge--pending` |
| `MERCHANT_CONFIRMATION_REQUESTED` | `PENDING_CONFIRMATION` | 確認中 | `badge--requested` |
| `MERCHANT_CONFIRMATION_REQUESTED` | `APPROVED` | 承認済み | `badge--approved` |
| `MERCHANT_CONFIRMATION_REQUESTED` | `DISPUTED` | 否認差戻 | `badge--disputed` |
| `RETURNED` | ― | 差し戻し | `badge--returned` |

---

## 画面セクション構成（`fe_page_detail.html`）

詳細画面には2つのメインセクションがあり、そのうち「要対応」セクションは差し戻し・否認の2つのサブセクションを持つ。すべて初期状態は `hidden`。

| セクションID | タイトル | 対象ステータス | 備考 |
|---|---|---|---|
| `detailActionRequiredSection` | ⚠ 要対応の請求一覧 | `RETURNED` + `DISPUTED` | CSVダウンロード・アップロードボタンあり |
| └ `detailReturnedSubsection` | 差し戻し | `RETURNED` | サブセクション（要対応の子要素） |
| └ `detailDisputedSubsection` | 否認 | `MERCHANT_CONFIRMATION_REQUESTED` + `DISPUTED` | サブセクション（要対応の子要素） |
| `detailNormalSection` | 確認中・承認済みの請求一覧 | 上記以外すべて | ボタンなし |

リスト本体はそれぞれ `detailReturnedList` / `detailDisputedList` / `detailNormalList`（JSが動的生成）。

---

## JS レンダリングの動作（`fe_js.html` detail.js セクション）

### `renderDetailStoreList_(stores)`

- ステータスで店舗を3分割:
  - `RETURNED` → 差し戻し
  - `MERCHANT_CONFIRMATION_REQUESTED` + `DISPUTED` → 否認
  - その他 → 正常（確認中・承認済み）
- 差し戻し or 否認が1件以上 → `detailActionRequiredSection` の `hidden` を解除
  - 差し戻しあり → `detailReturnedSubsection` + `detailReturnedList` に描画
  - 否認あり → `detailDisputedSubsection` + `detailDisputedList` に描画
- 正常が1件以上 → `detailNormalSection` + `detailNormalList` に描画

### `buildDetailAccordion_(store, openByDefault)`

- `RETURNED` の場合
  - 初期展開状態（`openByDefault=true`）
  - 差し戻しコメント（`backoffice_handover`）バナーを表示
  - USEN PAY社からのコメント + アクションボタン（取り下げ・修正アップ・変更なし再請求）
  - `store-accordion--returned` クラスを付与
- `DISPUTED`（`MERCHANT_CONFIRMATION_REQUESTED` + `DISPUTED`）の場合
  - 初期展開状態（`openByDefault=true`）
  - 否認理由（`store_disputed_reason`）+ 加盟店との合意内容入力欄 + アクションボタン
  - `store-accordion--returned` クラスを付与
- それ以外
  - 折りたたみ状態で表示
- ヘッダー行に `getDetailStatusBadge_(backofficeStatus, invoiceStatus)` でステータスバッジを表示
- 備考入力欄に `data-customer-code` 属性を付与（BEが `remarks[customerCode]` で参照するため）
- アコーディオン展開時に `loadDetailInvoiceLines_()` でオンデマンド明細取得（閉じると DOM を空にしてメモリ解放）

### `getDetailStatusBadge_(status)`

ステータス値に応じたバッジHTMLを返す関数。

---

## BQ クエリ（`fetchInvoiceDetail_`）

- `store_invoices` を全件取得し、`RETURNED` → `DISPUTED` → その他の順でソート、同一ステータス内は `mall_code` 昇順
  ```sql
  ORDER BY
    CASE
      WHEN si.backoffice_review_status = 'RETURNED' THEN 0
      WHEN si.backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED' AND si.invoice_status = 'DISPUTED' THEN 1
      ELSE 2
    END ASC,
    si.mall_code ASC
  ```
- 取得フィールド：`store_invoice_id`、`mall_code`、`invoice_number`、`backoffice_review_status`、`invoice_status`、各金額フィールド、`backoffice_handover`、`wholesaler_handover`、`wholesaler_remark`、`backoffice_remark`、`store_disputed_reason`

---

## 現状の課題・補足

- 要対応セクション内で差し戻し・否認をサブセクションで分けて表示。それ以外（`PENDING_REVIEW` / `APPROVED` / `PENDING_CONFIRMATION`）は「確認中・承認済み」セクションにまとめて表示。
- 明細（`invoice_lines`）はアコーディオン展開時にオンデマンド取得（`getInvoiceLinesByStore`）。IDOR対策として `store_invoices` と INNER JOIN し `wholesaler_id` を検証している。
