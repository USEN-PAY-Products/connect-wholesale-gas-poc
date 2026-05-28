# MYP-3433 請求書情報詳細画面の表示（否認・差し戻し対応）

> **ブランチ**: `feature/MYP-3433-wholesale-invoice-detail-rejection-status`  
> **最終更新**: 2026-05-28

---

## 1. 概要

請求書詳細画面（`#detail`）において、BackOffice側から **差し戻し（RETURNED）** や **否認（DISPUTED）** が発生した場合の表示・操作機能を実装した。

### 実装した主要機能

| # | 機能 | 概要 |
|---|------|------|
| 1 | 詳細画面デザイン刷新 | 確認画面と統一したカードUI、ステータスバッジ、アコーディオン表示 |
| 2 | 個別 CSV 再送信 | 差し戻し/否認された1加盟店分のCSVを再アップロード |
| 3 | 一括 CSV 再送信 | 要対応の全加盟店分のCSVをまとめて再アップロード |
| 4 | 変更なしで再請求 | CSV再アップロードなしでステータスのみ更新 |
| 5 | バージョン管理（方式A） | `wholesaler_invoices` は常に大元の親IDを参照 |

---

## 2. 変更ファイル一覧

| ファイル | 変更行数 | 変更内容 |
|----------|----------|----------|
| `src/be_invoice.js` | +540 | 再送信・一括再送信・変更なし再請求のBE関数追加 |
| `src/db_bq_query.js` | +107 | BQクエリ修正・ヘルパー関数追加 |
| `src/fe_js.html` | +809 | 詳細画面のFEロジック大幅追加 |
| `src/fe_css.html` | +562 | 詳細画面のスタイル追加・ステータスバッジ |
| `src/fe_page_detail.html` | +104 | 詳細画面HTMLテンプレート拡充 |

---

## 3. アーキテクチャ全体図

```mermaid
graph TB
    subgraph "フロントエンド（fe_js.html）"
        A[詳細画面 #detail]
        A --> B{加盟店ステータス}
        B -->|差し戻し RETURNED| C[⚠ 要対応セクション<br/>アコーディオン自動展開]
        B -->|否認 DISPUTED| C
        B -->|確認中 PENDING| D[確認中セクション<br/>アコーディオン閉じ]
        B -->|承認済 APPROVED| D
    end

    subgraph "アクション"
        C --> E[修正CSVアップロード<br/>モーダル]
        C --> F[変更なしで再請求<br/>ボタン]
        E -->|個別| G[resubmitInvoiceData]
        E -->|一括| H[bulkResubmitInvoiceData]
        F --> I[resubmitWithoutChanges]
    end

    subgraph "バックエンド（GAS）"
        G --> J[Drive保存 → Load Job → BQトランザクション]
        H --> J
        I --> K[BQ UPDATE のみ]
    end

    subgraph "BigQuery"
        J --> L[store_invoices<br/>旧: is_latest=FALSE<br/>新: INSERT]
        J --> M[invoice_lines<br/>新: INSERT]
        J --> N[wholesaler_invoices<br/>新: INSERT<br/>金額再計算]
        K --> O[store_invoices<br/>status → PENDING_REVIEW]
    end
```

---

## 4. 機能詳細

### 4-1. 詳細画面のステータス別表示

```mermaid
flowchart TD
    Start([詳細画面へ遷移]) --> Fetch[BQから親+子レコード取得<br/>fetchInvoiceDetailSummary_<br/>fetchStoreInvoicesByParent_]
    Fetch --> Render[画面レンダリング]
    Render --> Split{加盟店を<br/>ステータス分類}
    Split -->|RETURNED / DISPUTED| ActionSection["⚠ 要対応セクション<br/>・USEN PAYコメント表示<br/>・否認理由/合意内容表示<br/>・アクションボタン表示<br/>・アコーディオン自動展開"]
    Split -->|PENDING / APPROVED| NormalSection["確認中・承認済みセクション<br/>・アコーディオン閉じた状態"]
    ActionSection --> Buttons["【ボタン】<br/>① 修正CSVアップロード<br/>② 変更なしで再請求"]
```

#### ステータスバッジのスタイル

| ステータス | 背景色 | アイコン色 | ラベル |
|-----------|--------|-----------|--------|
| 差し戻し (RETURNED) | `#FFFEEF` | `#FF7846` | 差し戻し |
| 否認 (DISPUTED) | `#FFE4E4` | `#DF4C4C` | 否認 |
| 確認中 (PENDING_REVIEW) | `#EFEFF9` | — | 確認中 |
| 承認済み (APPROVED) | `#CDF6EF` | — | 承認済み |

---

### 4-2. 個別 CSV 再送信（`resubmitInvoiceData`）

差し戻し/否認された **1加盟店** の修正CSVをアップロードして再送信する。

```mermaid
sequenceDiagram
    participant FE as フロントエンド
    participant GAS as GAS (be_invoice.js)
    participant Drive as Google Drive
    participant BQ as BigQuery

    FE->>FE: CSVファイル選択・バリデーション<br/>（対象加盟店のcustomer_codeがCSVに含まれるか）
    FE->>FE: 確認モーダルで金額確認
    FE->>GAS: resubmitInvoiceData(<br/>rawCsv, utf8Csv, summaryData,<br/>remarks, parentInvoiceId,<br/>storeInvoiceId, handover)

    GAS->>Drive: CSV保存（_resubmit.csv）
    GAS->>BQ: Load Job → staging テーブル
    GAS->>BQ: fetchLatestWholesalerInvoice_()
    GAS->>BQ: fetchTargetStoreInvoiceAmounts_([storeInvoiceId])
    
    Note over GAS,BQ: BEGIN TRANSACTION
    GAS->>BQ: UPDATE store_invoices SET is_latest=FALSE<br/>WHERE id = storeInvoiceId
    GAS->>BQ: INSERT store_invoices（新レコード）
    GAS->>BQ: INSERT invoice_lines（stagingからJOIN）
    GAS->>BQ: INSERT wholesaler_invoices（金額再計算）
    Note over GAS,BQ: COMMIT

    GAS->>BQ: DROP staging テーブル
    GAS-->>FE: success

    FE->>FE: 詳細画面リロード（initDetailPage）
```

---

### 4-3. 一括 CSV 再送信（`bulkResubmitInvoiceData`）

要対応の **全加盟店** の修正CSVをまとめてアップロードする。

```mermaid
sequenceDiagram
    participant FE as フロントエンド
    participant GAS as GAS (be_invoice.js)
    participant BQ as BigQuery

    FE->>FE: CSVファイル選択・バリデーション<br/>（全要対応加盟店のcustomer_codeが<br/>CSVに含まれるかチェック）
    FE->>GAS: bulkResubmitInvoiceData(<br/>rawCsv, utf8Csv, summaryData,<br/>remarks, parentInvoiceId)

    GAS->>BQ: Load Job → staging
    GAS->>BQ: fetchLatestWholesalerInvoice_()
    GAS->>BQ: fetchTargetStoreInvoiceAmounts_(null)<br/>※ null = 全要対応を対象

    Note over GAS,BQ: BEGIN TRANSACTION
    GAS->>BQ: UPDATE store_invoices SET is_latest=FALSE<br/>WHERE status=RETURNED AND is_latest=TRUE
    GAS->>BQ: UPDATE store_invoices SET is_latest=FALSE<br/>WHERE status=MERCHANT_CONFIRMATION_REQUESTED<br/>AND invoice_status=DISPUTED AND is_latest=TRUE
    GAS->>BQ: INSERT store_invoices（全加盟店分）
    GAS->>BQ: INSERT invoice_lines（stagingからJOIN）
    GAS->>BQ: INSERT wholesaler_invoices（金額再計算）
    Note over GAS,BQ: COMMIT

    GAS-->>FE: success
    FE->>FE: 詳細画面リロード
```

---

### 4-4. 変更なしで再請求（`resubmitWithoutChanges`）

CSVの再アップロードなしで、ステータスのみ更新する。

```mermaid
flowchart TD
    A([「変更なしで再請求」ボタン押下]) --> B{加盟店の<br/>ステータス}
    B -->|否認 DISPUTED| C{合意事項<br/>入力済み?}
    C -->|未入力| D["alert: ⚠ 否認された請求を<br/>「変更なしで再申請」する場合は、<br/>〈加盟店との合意事項〉の項目を<br/>記入ください。"]
    C -->|入力済み| E[BE呼び出し]
    B -->|差し戻し RETURNED| E
    E --> F["BQ UPDATE store_invoices<br/>SET backoffice_review_status = 'PENDING_REVIEW'<br/>+ wholesaler_handover 更新"]
    F --> G[詳細画面リロード]
    D --> H([処理中断])
```

#### wholesaler_handover の更新ルール

| ケース | 更新動作 |
|--------|---------|
| 否認 → 入力値あり | 入力値で更新 |
| 差し戻し | 既存値を維持（`SET wholesaler_handover = wholesaler_handover`） |

---

### 4-5. バージョン管理（方式A: 常に大元の親ID参照）

再送信時に新規INSERTされる `wholesaler_invoices` と `store_invoices` は、常に **大元の親ID** を `wholesaler_invoice_id` に持つ。

```mermaid
graph LR
    subgraph "初回登録（V1）"
        WI1["wholesaler_invoices<br/>id: aaa<br/>wholesaler_invoice_id: NULL"]
        SI1A["store_invoices<br/>加盟店A<br/>wholesaler_invoice_id: aaa<br/>is_latest: FALSE"]
        SI1B["store_invoices<br/>加盟店B<br/>wholesaler_invoice_id: aaa<br/>is_latest: TRUE"]
    end

    subgraph "再送信（V2）"
        WI2["wholesaler_invoices<br/>id: bbb<br/>wholesaler_invoice_id: aaa ← 大元ID"]
        SI2A["store_invoices<br/>加盟店A（修正版）<br/>wholesaler_invoice_id: aaa ← 大元ID<br/>is_latest: TRUE"]
    end

    WI1 --> SI1A
    WI1 --> SI1B
    WI2 --> SI2A

    style WI2 fill:#e8f5e9
    style SI2A fill:#e8f5e9
    style SI1A fill:#ffebee
```

**方式Aを選択した理由:**
- BQ再帰CTE不要でクエリが簡潔
- `store_invoices` と `wholesaler_invoices` でルールが統一
- 詳細画面のサマリー取得が `WHERE (id = @id OR wholesaler_invoice_id = @id) ORDER BY created_at DESC LIMIT 1` で済む

---

### 4-6. 金額再計算ロジック

再送信時、`wholesaler_invoices` の金額は以下の式で再計算される:

$$\text{新WI金額} = \text{最新WI金額} - \text{旧対象store金額合計} + \text{新CSV金額}$$

```
例: 
  最新WI合計 = 100,000円
  旧対象store合計 = 30,000円（差し戻しされた加盟店A分）
  新CSV合計 = 35,000円（修正後の加盟店A分）
  → 新WI合計 = 100,000 - 30,000 + 35,000 = 105,000円
```

これにより、2回目以降の修正でも直前の修正結果がベースになり、正確な金額が維持される。

---

## 5. BQクエリの変更点

### 5-1. 既存クエリの修正

| クエリ関数 | 変更内容 | 理由 |
|-----------|---------|------|
| `fetchStoreInvoicesByParent_` | `AND si.is_latest = TRUE` 追加 | 再送信で `is_latest=FALSE` になった旧レコードを除外 |
| `fetchInvoiceDetailSummary_` | `WHERE (id = @id OR wholesaler_invoice_id = @id) ORDER BY created_at DESC LIMIT 1` | 再送信版（新WI）を含めて最新を取得 |
| `fetchInvoicesByWholesaler_` | `AND wholesaler_invoice_id IS NULL` 追加 | 再送信版を一覧画面から除外 |

### 5-2. 新規ヘルパー関数

| 関数 | 用途 |
|------|------|
| `fetchLatestWholesalerInvoice_` | 金額再計算のベースとなる最新WIを取得 |
| `fetchTargetStoreInvoiceAmounts_` | 旧対象storeの金額合計を取得（個別/一括両対応） |

---

## 6. FE バリデーション

### CSVアップロード時の追加チェック

```mermaid
flowchart TD
    A[CSVファイル選択] --> B{個別 or 一括?}
    B -->|個別| C["対象加盟店の customer_code が<br/>CSVに含まれているか？<br/>（merchant_mappings で mall_code → customer_code 逆引き）"]
    B -->|一括| D["全要対応加盟店の customer_code が<br/>CSVに含まれているか？<br/>（_detailActionRequiredMallCodes を走査）"]
    C -->|含まれない| E["エラー: 対象の加盟店（xxx）の<br/>データがCSVに見つかりません"]
    D -->|不足あり| F["エラー: 以下の加盟店のデータが<br/>CSVに見つかりません: xxx, yyy"]
    C -->|OK| G[確認画面表示]
    D -->|OK| G
```

---

## 7. セキュリティ設計

| 対策 | 詳細 |
|------|------|
| `wholesaler_id` の改ざん防止 | サーバー側 `getServerAccountInfo_()` で取得（フロントからは受け取らない） |
| UUID形式バリデーション | `parentInvoiceId`, `storeInvoiceId` を正規表現で検証 |
| SQLインジェクション対策 | `esc()` でシングルクォートエスケープ、金額は `Number()` + `isFinite()` |
| UPDATE条件の厳格化 | `WHERE id = ? AND wholesaler_invoice_id = ? AND wholesaler_id = ? AND is_latest = TRUE` |

---

## 8. 影響範囲・注意事項

- `wholesaler_invoices` の新規INSERT時、`wholesaler_invoice_id` に大元のIDを設定する（チェーン方式ではない）
- `resubmitWithoutChanges` では `invoice_status`（DISPUTED等）は変更しない — BackOffice側で確認が必要なため
- 一括再送信の UPDATE は差し戻し・否認を2つの UPDATE 文で分けて実行（`backoffice_review_status` の条件が異なるため）
- 一覧画面では `wholesaler_invoice_id IS NULL` で再送信版を除外している
