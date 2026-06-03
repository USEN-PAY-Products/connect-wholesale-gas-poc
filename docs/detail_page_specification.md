# 詳細画面（登録済み請求内容）仕様書

## 1. 概要

詳細画面は、卸事業者が登録済みの請求内容を確認・管理するための画面である。  
親請求（`wholesaler_invoices`）の基本情報と、配下の加盟店別請求（`store_invoices`）の一覧をアコーディオン形式で表示する。  
差し戻し・否認された請求に対しては、CSV再アップロード・変更なし再請求・請求取り下げの操作が可能。

### 画面URL

```
#detail/{wholesaler_invoice_id}
```

### 変更対象ファイル

| ファイル | 役割 |
|---------|------|
| `fe_page_detail.html` | 詳細画面の HTML テンプレート |
| `fe_js.html` | 詳細画面の描画ロジック・イベントハンドラ |
| `fe_css.html` | スタイル定義 |
| `be_invoice.js` | バックエンド API（GAS サーバーサイド） |
| `db_bq_query.js` | BigQuery クエリ関数 |

---

## 2. 画面構成

```mermaid
block-beta
  columns 1
  block:page["詳細画面 (#detail/{id})"]
    columns 1
    header["登録済み請求内容 ← 一覧に戻る"]
    block:summary["請求基本情報カード"]
      columns 2
      block:left["基本情報"]
        l1["請求月: YYYY/MM"]
        l2["登録日時: yyyy/mm/dd hh:mm:ss"]
        l3["手数料(x%): xxx円"]
        l4["振込予定金額: xxx円"]
        l5["USEN PAY社からのコメント: textarea"]
      end
      block:right["請求金額"]
        r1["合計（税込）: xxx円"]
        r2["小計（税抜）: xxx円"]
        r3["消費税: xxx円"]
        r4["内訳"]
        r5["10%対象小計 / 消費税"]
        r6["8%対象小計 / 消費税"]
      end
    end
    block:action["要対応の請求一覧 ＋ CSV一括アップロードボタン"]
      a1["⚠ 差戻し/否認された請求あり"]
      a2["── 差戻し ── 加盟店アコーディオン × N"]
      a3["── 否認 ── 加盟店アコーディオン × N"]
    end
    block:normal["確認中・承認済みの請求一覧"]
      n1["加盟店アコーディオン × N"]
    end
    footer["← 一覧に戻る"]
  end
```

### 2.1 加盟店アコーディオンの構成

```mermaid
block-beta
  columns 1
  block:accordion["加盟店アコーディオン"]
    columns 1
    accHeader["ヘッダー: 加盟店名 | 顧客ID | 請求金額 | 小計 | 消費税 | 10% | 8% | ステータス | ▼"]
    block:body["ボディ（展開時）"]
      columns 1
      b1["💬 差し戻しコメント（差戻しの場合）"]
      b2["否認理由 / 【必須】加盟店との合意内容（否認の場合）"]
      b3["請求取り下げ / 修正ファイルをアップ / 変更なしで再請求"]
      b4["加盟店請求書備考: input"]
      b5["明細テーブル: 取引日 | 明細項目 | 単価 | 数量 | 金額 | 税 | 備考"]
    end
  end
```

---

## 3. ステータス体系

### 3.1 ステータスバッジ一覧

| `backoffice_review_status` | `invoice_status` | バッジ表示 | バッジクラス | セクション |
|---------------------------|-----------------|-----------|-------------|-----------|
| - | `WITHDRAWN` | ✓ 取下げ済 | `badge--withdrawn` | 否認 |
| `MERCHANT_CONFIRMATION_REQUESTED` | `DISPUTED` | ⊖ 否認差戻 | `badge--disputed` | 否認 |
| `RETURNED` | `DISPUTED` | ⊖ 否認差戻 | `badge--disputed` | 否認 |
| `PENDING_REVIEW` | `DISPUTED` | 未検閲 | `badge--pending` | 否認 |
| `RETURNED` | その他 | ↺ 差戻し | `badge--returned` | 差戻し |
| `MERCHANT_CONFIRMATION_REQUESTED` | `APPROVED` | ✓ 承認 | `badge--approved` | 確認中・承認済み |
| `MERCHANT_CONFIRMATION_REQUESTED` | `PENDING_CONFIRMATION` | 確認中 | `badge--requested` | 確認中・承認済み |
| その他 | その他 | 未検閲 | `badge--pending` | 確認中・承認済み |

### 3.2 セクション振り分けロジック

```mermaid
flowchart TD
    A[store_invoice レコード] --> B{invoice_status\n== DISPUTED?}
    B -- Yes --> C["否認セクション\n（backoffice_review_status は問わず）"]
    B -- No --> D{backoffice_review_status\n== RETURNED?}
    D -- Yes --> E["差戻しセクション"]
    D -- No --> F["確認中・承認済みセクション"]
```

---

## 4. 画面遷移フロー

### 4.1 全体フロー

```mermaid
flowchart TD
    TOP["TOP画面（一覧）"] -->|請求レコードクリック| DETAIL["詳細画面\n#detail/{id}"]
    DETAIL -->|← 一覧に戻る| TOP
    DETAIL -->|CSV一括アップロード| MODAL_BULK["アップロードモーダル"]
    MODAL_BULK --> CONFIRM["確認画面 #confirm"]
    CONFIRM -->|登録成功| DETAIL
    DETAIL -->|修正ファイルをアップ| MODAL_SINGLE["アップロードモーダル\n（モーダル内完結）"]
    MODAL_SINGLE -->|登録成功| DETAIL
    DETAIL -->|変更なしで再請求| BE_RESUBMIT["BE: resubmitWithoutChanges"]
    BE_RESUBMIT --> DETAIL
    DETAIL -->|請求取り下げ| DIALOG["確認ダイアログ"]
    DIALOG -->|取り下げる| BE_WITHDRAW["BE: withdrawStoreInvoice"]
    BE_WITHDRAW --> DETAIL
    DIALOG -->|キャンセル| DETAIL
```

### 4.2 ページ読み込みシーケンス

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant FE as FE (fe_js.html)
    participant BE as BE (be_invoice.js)
    participant BQ as BigQuery

    U->>FE: #detail/{id} アクセス
    FE->>FE: initDetailPage(id)
    FE->>FE: キャッシュチェック（同一IDならスキップ）
    FE->>FE: resetDetailPage_()
    FE-->>U: ローディング表示

    FE->>BE: fetchInvoiceDetail(id)
    BE->>BQ: fetchInvoiceDetailSummary_(id)
    BQ-->>BE: summary data
    BE->>BQ: fetchInvoiceDetailStores_(id)
    BQ-->>BE: stores data
    BE-->>FE: { summary, stores }

    FE->>FE: renderDetailPage_()
    FE->>FE: renderDetailSummary_()
    FE->>FE: renderDetailStoreList_()
    Note over FE: returned[] → 差戻しセクション<br/>disputed[] → 否認セクション<br/>normal[] → 確認中・承認済み
    FE-->>U: 画面表示完了

    U->>FE: アコーディオン展開（明細クリック）
    FE->>BE: loadDetailInvoiceLines_(storeId)
    BE->>BQ: fetchInvoiceDetailLines_(storeId)
    BQ-->>BE: lines data
    BE-->>FE: lines[]
    FE-->>U: 明細テーブル表示
```

---

## 5. 操作フロー詳細

### 5.1 修正ファイルをアップ（個別リアップロード — モーダル内完結）

```mermaid
flowchart TD
    START["「修正ファイルをアップ」\nボタン押下"] --> MODAL["モーダル表示\nPhase 1: ファイルアップロード\n※「確認画面へ進む」非表示"]
    MODAL --> CSV["CSVファイル選択\n（D&D or ファイル選択）"]
    CSV --> VALIDATE["CSVバリデーション"]
    VALIDATE -->|NG| ERROR1["エラー表示\n→ 再選択可能"]
    VALIDATE -->|対象外加盟店含む| ERROR2["エラー表示\n対象の加盟店のみを\n含めてください"]
    VALIDATE -->|OK| PREVIEW["Phase 2: プレビュー表示"]

    PREVIEW --> DELETE{"「ファイルを削除する」?"}
    DELETE -->|Yes| MODAL
    PREVIEW --> TAX_EDIT["税額 input 編集"]
    TAX_EDIT --> RECALC["recalcPreview_()\n消費税・請求金額 再計算"]
    PREVIEW --> OATH["☑ 誓約チェック ON"]
    OATH --> ENABLED["「登録する」活性化"]
    ENABLED --> SUBMIT["「登録する」押下"]
    SUBMIT --> CHECK_HANDOVER{"合意事項\n入力済み?"}
    CHECK_HANDOVER -->|未入力| ALERT_ERR["alert エラー"]
    CHECK_HANDOVER -->|OK| BE_CALL["BE: resubmitInvoiceData()"]
    BE_CALL -->|成功| CLOSE["モーダル閉じ\n→ 詳細リロード"]
    BE_CALL -->|失敗| ALERT_FAIL["alert エラー"]
```

#### シーケンス図

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant M as モーダル (FE)
    participant BE as BE (be_invoice.js)
    participant BQ as BigQuery / Drive

    U->>M: 「修正ファイルをアップ」押下
    M->>M: openModal(id, el, false)
    M-->>U: Phase 1 表示（footer非表示）

    U->>M: CSV選択
    M->>M: handleFile_() → validateCsv_()
    Note over M: ヘッダ/行チェック<br/>顧客コードチェック
    M->>M: showSuccess_() → renderModalPreview_()
    M-->>U: Phase 2 表示

    U->>M: 税額編集
    M->>M: recalcPreview_()

    U->>M: ☑ 誓約チェック
    M->>M: submitBtn.disabled = false

    U->>M: 「登録する」押下
    M->>M: buildResubmitSummaryData_(parsedData)
    M->>BE: resubmitInvoiceData()
    BE->>BQ: CSV → Drive保存
    BE->>BQ: CSV → BQ Staging Load
    BE->>BQ: 既存金額取得 → 差額計算
    BE->>BQ: INSERT 新store_invoices
    BE->>BQ: UPDATE 旧is_latest=FALSE
    BE->>BQ: UPDATE wholesaler_invoices
    BQ-->>BE: OK
    BE-->>M: success
    M->>M: closeModal() → initDetailPage(id)
    M-->>U: 詳細リロード
```

### 5.2 CSV一括アップロード（確認画面経由）

```mermaid
flowchart TD
    START["「CSV一括アップロード」\nボタン押下"] --> MODAL["モーダル表示\nPhase 1: ファイルアップロード\n※「確認画面へ進む」表示"]
    MODAL --> CSV["CSVファイル選択"]
    CSV --> VALIDATE["CSVバリデーション"]
    VALIDATE -->|NG| ERROR["エラー表示\n→ 再選択可能"]
    VALIDATE -->|OK| SELECTED["ファイル情報表示\n+ ボタン活性化"]
    SELECTED --> BTN_CONFIRM["「確認画面へ進む」押下"]
    BTN_CONFIRM --> COLLECT["備考・合意事項を収集"]
    COLLECT --> CHECK{"否認加盟店の\n合意事項\n入力済み?"}
    CHECK -->|未入力あり| ALERT["alert エラー"]
    CHECK -->|OK| SAVE_CTX["再送信コンテキスト保存\n_isResubmitConfirm = true\n_resubmitParentInvoiceId\n_resubmitRemarks\n_resubmitHandovers"]
    SAVE_CTX --> CONFIRM["確認画面 (#confirm) へ遷移\nタイトル: 再請求内容の確認\nUSEN PAY社コメント表示"]
    CONFIRM --> REGISTER["誓約チェック\n+ 「登録する」押下"]
    REGISTER --> BULK_BE["bulkResubmitInvoiceData()"]
    BULK_BE -->|成功| DETAIL["詳細画面にリダイレクト"]
```

### 5.3 変更なしで再請求

```mermaid
flowchart TD
    START["「変更なしで再請求」\nボタン押下"] --> CHECK{"合意事項の\n必須チェック\n（否認の場合）"}
    CHECK -->|未入力| TOAST["トースト表示\n合意事項の項目を記入ください"]
    CHECK -->|OK| LOADING["showLoadingOverlay\n「再請求中...」"]
    LOADING --> BE["BE: resubmitWithoutChanges()\nstoreInvoiceId\nparentInvoiceId\nwholesalerHandover"]
    BE --> BQ_UPDATE["BQ UPDATE\nbackoffice_review_status = PENDING_REVIEW\nwholesaler_handover = 入力値 or 既存値維持"]
    BQ_UPDATE -->|成功| RELOAD["詳細画面リロード\nステータス: 未検閲\nセクション: 否認"]
    BQ_UPDATE -->|失敗| ALERT["alert エラー"]
```

#### シーケンス図

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant FE as FE
    participant BE as BE
    participant BQ as BigQuery

    U->>FE: 「変更なしで再請求」押下
    FE->>FE: 合意事項チェック
    FE->>BE: resubmitWithoutChanges()
    BE->>BQ: UPDATE store_invoices<br/>SET backoffice_review_status='PENDING_REVIEW'<br/>WHERE id=? AND wholesaler_id=?
    BQ-->>BE: OK
    BE-->>FE: success
    FE->>FE: initDetailPage(id)
    FE-->>U: 詳細リロード
```

### 5.4 請求取り下げ

```mermaid
flowchart TD
    START["「請求取り下げ」\nボタン押下"] --> DIALOG["確認ダイアログ表示\n⚠ 加盟店への請求情報を\n取り下げます。よろしいですか？"]

    DIALOG --> CANCEL{"ユーザー選択"}
    CANCEL -->|キャンセル| CLOSE["ダイアログ閉じ"]
    CANCEL -->|取り下げる| DISABLE["ボタン無効化\n+ スピナー表示"]
    DISABLE --> BE["BE: withdrawStoreInvoice()\nstoreInvoiceId\nparentInvoiceId"]
    BE --> BQ["BQ UPDATE:\ninvoice_status = WITHDRAWN"]
    BQ -->|成功| SUCCESS["ボタンエリア → ✓ 取り下げ済み バッジ\nステータスバッジ → ✓ 取下げ済"]
    BQ -->|失敗| FAIL["alert エラー\n→ ボタン復元"]
```

#### シーケンス図

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant FE as FE
    participant BE as BE
    participant BQ as BigQuery

    U->>FE: 「請求取り下げ」押下
    FE-->>U: 確認ダイアログ表示

    U->>FE: 「取り下げる」押下
    FE->>FE: executeWithdraw_()
    FE->>BE: withdrawStoreInvoice()
    BE->>BQ: UPDATE store_invoices<br/>SET invoice_status='WITHDRAWN'
    BQ-->>BE: OK
    BE-->>FE: success
    FE-->>U: バッジ更新（取下げ済）
```

---

## 6. データ構造

### 6.1 API レスポンス: `fetchInvoiceDetail`

```javascript
{
  data: {
    summary: {
      wholesaler_invoice_id: "uuid",
      wholesaler_invoice_date: "2026-03-01",    // → 請求月 (YYYY/MM)
      created_at: "2026/03/15 10:30:00",        // → 登録日時
      invoice_fee_rate: 3.0,                     // → 手数料率
      invoice_fee_amount: 5000,                  // → 手数料額
      payment_amount: 165000,                    // → 振込予定金額
      handover_matter: "...",                     // → USEN PAY社コメント
      total_amount: 170000,                      // → 合計（税込）
      subtotal_amount: 155000,                   // → 小計（税抜）
      tax_amount: 15000,                         // → 消費税
      standard_tax_target_amount: 100000,        // → 10%対象小計
      standard_tax_amount: 10000,                // → 10%消費税
      reduced_tax_target_amount: 55000,          // → 8%対象小計
      reduced_tax_amount: 5000,                  // → 8%消費税
      // wholesaler_invoices の金額フィールド（卸側サマリ）
      wholesaler_total_amount: 170000,
      wholesaler_subtotal_amount: 155000,
      wholesaler_tax_amount: 15000,
      wholesaler_standard_tax_target_amount: 100000,
      wholesaler_standard_tax_amount: 10000,
      wholesaler_reduced_tax_target_amount: 55000,
      wholesaler_reduced_tax_amount: 5000,
    },
    stores: [
      {
        store_invoice_id: "uuid",
        mall_code: "M001",
        store_name: "テスト加盟店1",
        total_amount: 50000,
        subtotal_amount: 45000,
        tax_amount: 5000,
        standard_tax_amount: 3000,
        reduced_tax_amount: 2000,
        backoffice_review_status: "RETURNED",
        invoice_status: "DISPUTED",
        backoffice_handover: "差し戻しコメント",
        store_disputed_reason: "金額間違い",
        wholesaler_handover: "合意事項テキスト",
        wholesaler_remark: "備考テキスト",
      },
      // ... 他の加盟店
    ]
  }
}
```

### 6.2 `buildResubmitSummaryData_` の出力

```javascript
{
  wholesalerTotal: {
    totalAmount: 170000,
    subtotalAmount: 155000,
    taxAmount: 15000,
    exTax10: 100000,
    tax10: 10000,
    exTax8: 55000,
    tax8: 5000,
    feeAmount: 0,
    paymentAmount: 170000,
  },
  merchantTotals: [
    {
      customerCode: "C001",
      totalAmount: 50000,
      subtotalAmount: 45000,
      taxAmount: 5000,
      exTax10: 30000,
      tax10: 3000,
      exTax8: 15000,
      tax8: 2000,
    }
  ]
}
```

### 6.3 CSV パース後データ構造（`parsedData`）

```javascript
[
  {
    customer_code: "C001",
    merchant_name: "テスト加盟店1",
    transaction_date: "2026-03-01",
    item_name: "ガス代",
    unit_price: 1000,
    quantity: 10,
    amount_ex_tax: 10000,
    tax_rate: 10,
    tax_amount: 1000,
    invoice_detail_remark: "備考",
  },
  // ...
]
```

---

## 7. グローバル変数

| 変数名 | 型 | 用途 |
|--------|------|------|
| `_detailCurrentInvoiceId` | `string\|null` | 表示中の `wholesaler_invoice_id`。同一IDの再描画スキップに使用 |
| `_detailActionRequiredMallCodes` | `string[]` | 要対応（差戻し＋否認）の `mall_code` 一覧。バリデーション用 |
| `_detailReturnedOnlyMallCodes` | `string[]` | RETURNED かつ `invoice_status` が null の `mall_code`。CSV未含有時に警告のみ（エラーにしない） |
| `_isResubmitConfirm` | `boolean` | 一括再送信モードで確認画面を表示するフラグ |
| `_resubmitParentInvoiceId` | `string\|null` | 一括再送信時の親請求ID |
| `_resubmitRemarks` | `Object` | 一括再送信時の備考 `{ customerCode: value }` |
| `_resubmitHandovers` | `Object` | 一括再送信時の合意事項 `{ customerCode: value }` |
| `rawCsvBase64` | `string\|null` | 生CSV（Shift-JIS）の Base64。BE送信用 |
| `utf8CsvBase64` | `string\|null` | UTF-8変換CSVの Base64。BQ Load Job用 |
| `parsedData` | `Array\|null` | CSVパース結果の行配列。プレビュー描画・サマリ算出に使用 |

---

## 8. モーダル状態遷移

### 8.1 修正ファイルアップロードモーダル（個別）

```mermaid
stateDiagram-v2
    [*] --> CLOSED

    CLOSED --> PHASE1_UPLOAD: ボタン押下\n(footer非表示)

    PHASE1_UPLOAD --> PHASE1_ERROR: CSV NG
    PHASE1_UPLOAD --> PHASE2_PREVIEW: CSV OK

    PHASE1_ERROR --> PHASE1_UPLOAD: 再選択

    PHASE2_PREVIEW --> PHASE1_UPLOAD: ファイルを削除する

    PHASE2_PREVIEW --> PHASE2_SUBMITTABLE: 誓約チェック ON

    PHASE2_SUBMITTABLE --> SUBMITTING: 登録する 押下

    SUBMITTING --> CLOSED: 成功\n(詳細リロード)
    SUBMITTING --> PHASE2_PREVIEW: 失敗\n(alertエラー)
```

### 8.2 修正ファイルアップロードモーダル（一括）

```mermaid
stateDiagram-v2
    [*] --> CLOSED

    CLOSED --> PHASE1_UPLOAD: ボタン押下\n(footer表示)

    PHASE1_UPLOAD --> PHASE1_ERROR: CSV NG
    PHASE1_UPLOAD --> PHASE1_SELECTED: CSV OK

    PHASE1_ERROR --> PHASE1_UPLOAD: 再選択

    PHASE1_SELECTED --> CONFIRM_PAGE: 確認画面へ進む 押下

    CONFIRM_PAGE --> [*]: 確認画面(#confirm)へ遷移
```

### 8.3 請求取り下げ確認ダイアログ

```mermaid
stateDiagram-v2
    [*] --> CLOSED

    CLOSED --> DIALOG_OPEN: 請求取り下げ 押下

    DIALOG_OPEN --> CLOSED: キャンセル

    DIALOG_OPEN --> PROCESSING: 取り下げる

    PROCESSING --> BADGE_UPDATED: 成功\n(取下げ済バッジ表示)
    PROCESSING --> DIALOG_OPEN: 失敗\n(ボタン復元)
```

---

## 9. バリデーション

### 9.1 CSV バリデーション（共通）

| チェック項目 | エラー/警告 | 内容 |
|-------------|-----------|------|
| ファイル拡張子 | エラー | `.csv` のみ許可 |
| ヘッダー行 | エラー | 必須カラムの存在確認 |
| データ行 | エラー | 数値・日付フォーマット等 |
| 要対応加盟店の網羅性 | エラー/警告 | CSVに要対応の `mall_code` が含まれているか |

### 9.2 個別リアップロード時の追加チェック

| チェック項目 | タイミング | 内容 |
|-------------|-----------|------|
| 対象外加盟店チェック | `renderModalPreview_` 冒頭 | CSVに対象加盟店以外の `customer_code` が含まれている場合エラー |
| 合意事項 必須 | 「登録する」押下時 | `previewHandoverInput` が空の場合 alert |

### 9.3 一括アップロード時の追加チェック

| チェック項目 | タイミング | 内容 |
|-------------|-----------|------|
| 否認加盟店の合意事項 | 「確認画面へ進む」押下時 | すべての否認加盟店の `handover-input` が入力済みか |
| RETURNED+null 加盟店 | CSV バリデーション時 | 警告のみ（エラーにしない） |
| RETURNED+DISPUTED 加盟店 | CSV バリデーション時 | エラー |

---

## 10. UI デザイン仕様

### 10.1 ステータスバッジ

| バッジ | 文字色 | 背景色 | アイコン |
|--------|--------|--------|---------|
| 取下げ済 | `#159E85` | `#CDF6EF` | `fa-check` |
| 否認差戻 | (disputed色) | (disputed背景) | `fa-minus-circle` |
| 差戻し | (returned色) | (returned背景) | `fa-rotate-left` |
| 承認 | (approved色) | (approved背景) | `fa-circle-check` |
| 確認中 | (requested色) | (requested背景) | なし |
| 未検閲 | (pending色) | (pending背景) | なし |

### 10.2 アクションボタン（否認セクション）

| ボタン | アイコン色 | テキストスタイル |
|--------|----------|----------------|
| 請求取り下げ | `#DF4C4C` | 14px / normal / 400 / color `#3C3C3C` |
| 修正ファイルをアップ | `#00A7B8` | 14px / normal / 400 |
| 変更なしで再請求 | `#00A7B8` | 14px / normal / 400 |

### 10.3 取り下げ確認ダイアログ

| 項目 | 値 |
|------|-----|
| ダイアログサイズ | 505 × 291px |
| 背景色 | `#FFF1EC` |
| ボーダー | 2px solid `#DF4C4C` |
| タイトル色 | `#FF7846`、font: 16px / 700 / 140% |
| 本文 | font: 16px / 400 / 120% |
| 「取り下げる」ボタン | 212 × 40px、背景 `#00A7B8`、角丸 999px |
| 「キャンセル」ボタン | 212 × 40px、outline、角丸 999px |

### 10.4 モーダル内プレビュー

| 項目 | 値 |
|------|-----|
| モーダル幅 | 1121px |
| 金額ヘッダー | `store-accordion__header` クラス（詳細画面と同一） |
| 否認理由・合意事項 | `backoffice-remark` クラス（詳細画面と同一） |
| 備考 | `store-accordion__remarks` クラス（詳細画面と同一） |
| 明細テーブル | `detail-table` クラス、max-height: 300px、スクロール可能 |
| 明細ヘッダー | sticky 固定、背景 `#EAEBED` |
| カード角丸 | `border-radius: 8px`、`border: 1px solid #E0E0E0` |

---

## 11. BE API 仕様

### 11.1 `fetchInvoiceDetail(invoiceId)`

| 項目 | 内容 |
|------|------|
| 引数 | `invoiceId`: `wholesaler_invoice_id` |
| 処理 | `fetchInvoiceDetailSummary_` + `fetchInvoiceDetailStores_` を呼び出し |
| 戻り値 | `{ data: { summary, stores } }` |
| IDOR保護 | `wholesaler_id` によるフィルタリング |

### 11.2 `resubmitInvoiceData(rawCsv, utf8Csv, summaryData, remarks, parentId, storeId, handover)`

| 項目 | 内容 |
|------|------|
| 処理 | CSV → Drive保存 → BQ Staging Load → 差額計算 → トランザクション実行 |
| トランザクション内容 | 新 `store_invoices` INSERT + 旧 `is_latest=FALSE` + `wholesaler_invoices` 金額更新 |

### 11.3 `resubmitWithoutChanges(storeInvoiceId, parentInvoiceId, wholesalerHandover)`

| 項目 | 内容 |
|------|------|
| 処理 | `backoffice_review_status` → `PENDING_REVIEW` に更新 |
| 条件 | RETURNED または (MERCHANT_CONFIRMATION_REQUESTED + DISPUTED) のレコードのみ |

### 11.4 `withdrawStoreInvoice(storeInvoiceId, parentInvoiceId)`

| 項目 | 内容 |
|------|------|
| 処理 | `invoice_status` → `WITHDRAWN` に更新 |
| IDOR保護 | `wholesaler_id` + `wholesaler_invoice_id` でフィルタリング |

---

## 12. BQ テーブル参照

### 使用テーブル

| テーブル | 用途 |
|---------|------|
| `wholesaler_invoices` | 親請求情報（金額サマリ、手数料、振込予定額） |
| `store_invoices` | 加盟店別請求（ステータス、金額、備考、合意事項） |
| `invoice_lines` | 明細行（品名、単価、数量、税率） |
| `merchant_mappings` | `mall_code` ↔ `customer_code` 変換 |
| `store` | 加盟店名の取得 |

### 主要クエリ

| 関数 | 対象テーブル | 概要 |
|------|------------|------|
| `fetchInvoiceDetailSummary_` | `wholesaler_invoices` | 親請求の最新レコードを取得 |
| `fetchInvoiceDetailStores_` | `store_invoices` JOIN `store` | 加盟店別請求一覧（`is_latest=TRUE`） |
| `fetchInvoiceDetailLines_` | `invoice_lines` JOIN `store_invoices` | 明細行（最大1000行） |
