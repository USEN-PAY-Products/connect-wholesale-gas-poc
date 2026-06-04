# CSV アップロード画面 バリデーション一覧

## 概要

CSVアップロード画面（請求内容の登録）で実行されるバリデーションの一覧。  
フロントエンド側は `fe_js.html` の `validateCsv()` 関数で実行される。

---

## 1. ファイルレベルチェック

| # | チェック内容 | エラーメッセージ |
|---|---|---|
| 1 | CSVが空（行が0件） | `CSVが空です。ヘッダー行とデータ行を含むCSVをアップロードしてください` |
| 2 | ヘッダー行の列数不一致 | `ヘッダー行のカラム数が正しくありません（N列 / 期待値: M列）` |
| 3 | ヘッダー名の不一致（列ごと） | `ヘッダー行 N列目: "期待値" が期待されますが "実際値" になっています` |
| 4 | データ行が0件（ヘッダーのみ） | `CSVにデータ行が1件もありません` |

※ ファイルレベルのエラーが検出された場合、データ行のチェックは行わない（早期リターン）。

---

## 2. 行レベルチェック（各データ行）

| # | チェック内容 | 対象列 | エラーメッセージ |
|---|---|---|---|
| 5 | 列数不一致 | 行全体 | `N行目: カラム数が正しくありません（N列 / 期待値: M列）` |
| 6 | 必須項目が空 | `required: true` の全列 | `N行目: "列名" は必須項目です` |
| 7 | 日付形式不正 | `type: 'date'` の列 | `N行目: "列名" はYYYY-MM-DD形式（例: 2026-03-01）で入力してください` |
| 8 | 未対応の日付フォーマット | `type: 'date'` の列 | `N行目: "列名" の日付フォーマット "X" は未対応です…` |
| 9 | 整数型に非整数値 | `type: 'integer'` の列 | `N行目: "列名" は整数で入力してください` |
| 10 | enum 制約違反 | `enum` 定義がある列（税率区分） | `N行目: "列名" は 8 または 10 を入力してください` |
| 11 | 文字列長超過 | `max_length` 定義がある列 | `N行目: "列名" はN文字以内で入力してください` |
| 12 | 顧客コードが空 | `customer_code` | `N行目: "得意先コード" は必須です` |
| 13 | 顧客コードが無効 | `customer_code` | `N行目: "X" は請求可能な加盟店コードではありません` |

---

## 3. デフォルト CSV カラム定義

`csv_format_rules` が未設定の場合に使用されるデフォルト定義（`DEFAULT_CSV_COLUMNS_`）。

| 列番号 | ヘッダー名 | system_column | 型 | 必須 | 追加制約 |
|---|---|---|---|---|---|
| 0 | 顧客コード | `customer_code` | string | ✅ | `merchant_mappings` との照合 |
| 1 | 日付 | `transaction_date` | date | ✅ | YYYY-MM-DD 形式 |
| 2 | 品目 | `item_name` | string | ✅ | |
| 3 | 数量 | `quantity` | integer | ✅ | |
| 4 | 単価 | `unit_price` | integer | ✅ | |
| 5 | 税率区分(%) | `tax_rate` | integer | ✅ | `enum: [8, 10]` |
| 6 | 請求金額（税抜） | `amount_ex_tax` | integer | ✅ | |
| 7 | 消費税 | `tax_amount` | integer | ✅ | |
| 8 | 備考 | `invoice_detail_remark` | string | ❌ | |

---

## 4. 日付フォーマット対応表

| format 値 | 正規表現 | 例 |
|---|---|---|
| `YYYY-MM-DD`（デフォルト） | `/^\d{4}-\d{2}-\d{2}$/` | 2026-03-01 |
| `YYYYMMDD` | `/^\d{8}$/` | 20260301 |
| `YYYY/MM/DD` | `/^\d{4}\/\d{2}\/\d{2}$/` | 2026/03/01 |

上記以外の format が指定された場合は「未対応フォーマット」エラーとなる。

---

## 5. その他（UI・エンコーディング）

| 項目 | 内容 |
|---|---|
| ファイル形式 | `.csv` のみ受付（`accept=".csv"`） |
| 文字コード | UTF-8 でデコード試行 → 失敗時は Shift_JIS としてデコード |
| エラー時の挙動 | 「確認画面へ進む」ボタンが `disabled` になり遷移不可 |
| エラー表示 | エラー／アラート一覧カードに行番号付きで表示 |

---

## 6. バックエンド側バリデーション（参考）

`be_csv_mapper.js` にて BigQuery INSERT 時にも以下のバリデーションが二重で実行される。

- CSVヘッダーの列名・列数チェック（`validateCsvHeaderByRules_()`）
- 必須列の空チェック（`COUNTIF` による検知）
- 日付型の形式チェック（`SAFE.PARSE_DATE` の NULL 検知）
- 整数型の非数値チェック（`SAFE_CAST` の NULL 検知）
- `amount_ex_tax` / `tax_rate` の非数値ガード

---

## 関連ファイル

- `src/fe_js.html` — フロントエンドバリデーション（`validateCsv()`, `parseCsvLine()`）
- `src/fe_page_csv_upload.html` — アップロード画面 HTML
- `src/be_csv_mapper.js` — バックエンドバリデーション・SQL生成

---

# 改修計画: 当月重複アップロード制限 ＋ 加盟店網羅性チェック ＋ 数量の小数対応

## 背景・要件

### 当月重複アップロード制限
- **目的**: 同一月内に複数回の新規請求書アップロードを防止する。
- **「当月」の定義**: `wholesaler_invoices.created_at` がアップロード操作時点の月（カレンダー月）の範囲内かどうか。CSVの内容（取引日等）は関係ない。
- **制限範囲**: アップロード画面（`#upload`）＝新規請求のみが対象。差し戻し・否認時の再アップロード（詳細画面のモーダル経由）は制限しない。
- **UI挙動**: 「新規請求を登録する」ボタンは**常に活性**。CSVアップロード時のバリデーション結果として**エラー表示**（ブロッキング）する。
- **チェック箇所**: フロントエンド（sessionStorageキャッシュ）＋バックエンド（BQリアルタイムクエリ）の二重チェック。
  - **フロント**: ホーム画面で `fetchInvoices()` の結果を `sessionStorage` にキャッシュ → アップロード画面でCSV読み込み時に参照し即時フィードバック（UX向上用）。
  - **バックエンド**: 送信時に `wholesaler_invoices` テーブルを直接確認 → 別タブ・別端末から登録されていても**確実にブロック**（最終防衛ライン）。

### 加盟店網羅性チェック（新規）
- **目的**: 卸側が請求可能な全加盟店がCSV内に含まれているかを確認する。
- **チェック方法**: `merchant_mappings` に登録されている加盟店のうち、CSVの `customer_code` に出現しない加盟店をアラートとして表示する。
- **UI挙動**: **アラート**（非ブロッキング）。エラーではないため、「確認画面へ進む」ボタンは有効のまま。
- **エラー文言例**: `〇〇店の請求明細がありません。`

### 数量の小数対応
- **目的**: `quantity`（数量）に小数値（例: `4.5`）を許容する。重量単位（kg等）での請求に対応するため。
- **BQスキーマ**: `quantity` カラムは既に `NUMERIC(6)` 型のため、スキーマ変更は不要。
- **金額フィールド**: マイナス値は引き続き許容。整数のまま変更なし。

---

## 設計方針

### エラーとアラートの区別

`renderErrors()` を拡張し、**エラー**（ブロッキング）と**アラート**（非ブロッキング）の2種を受け付ける。

| 種別 | CSSクラス | アイコン色 | ボタンへの影響 |
|---|---|---|---|
| エラー | `alert-item--error` | 赤 | `disabled` にする（送信不可） |
| アラート | `alert-item--warn` | オレンジ（既存CSS定義あり） | 影響なし（送信可能） |

表示順: エラー → アラートの順にリスト表示する。

---

## 実装ステップ

### Step 1: フロント — `fetchInvoices()` 結果を sessionStorage にキャッシュ

**対象ファイル**: `src/fe_js.html`

**変更内容**:
1. `initHomePage()` 内の `fetchInvoices()` の `withSuccessHandler` で、`result.data` を `sessionStorage` に保存。
2. キー名: `shiire_invoices_cache`

**実装イメージ**:
```javascript
// fetchInvoices の成功ハンドラ内
sessionStorage.setItem('shiire_invoices_cache', JSON.stringify(result.data || []));
renderBillingHistory(result.data || []);
```

---

### Step 2: フロント — CSVアップロード時の当月重複チェック

**対象ファイル**: `src/fe_js.html`

**変更内容**:
1. CSVバリデーション完了後（`validateCsv()` の後）に `sessionStorage` から請求データを取得。
2. `created_at`（`YYYY/MM/DD` 形式）が当月に該当するレコードが存在すればエラーを追加。

**判定ロジック**:
```javascript
const cachedInvoices = JSON.parse(sessionStorage.getItem('shiire_invoices_cache') || '[]');
const now = new Date();
const currentYM = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
const hasCurrentMonth = cachedInvoices.some(inv => inv.created_at && inv.created_at.startsWith(currentYM));
if (hasCurrentMonth) {
  errors.push('今月は既に新規の請求書が登録されています。差し戻しや否認の修正版のアップロードは詳細画面からアップロードしてください。');
}
```

**挿入箇所**: `validateCsv(text)` の呼び出し直後、`renderErrors()` の前。

---

### Step 3: フロント — 加盟店網羅性チェック（アラート）

**対象ファイル**: `src/fe_js.html`

**変更内容**:
1. CSVバリデーション完了後、`merchant_mappings` の全加盟店とCSV内の `customer_code` を突合。
2. CSV内に存在しない加盟店があれば**アラート**（非ブロッキング）として追加。

**判定ロジック**:
```javascript
const mappings = getMerchantMappings();
const csvCustomerCodes = new Set(rows.map(r => String(r.customer_code)));
const warnings = [];
mappings.forEach(m => {
  if (!csvCustomerCodes.has(String(m.customer_code))) {
    warnings.push(m.store_name + 'の請求明細がありません。');
  }
});
```

---

### Step 4: フロント — `renderErrors()` をエラー＋アラート対応に拡張

**対象ファイル**: `src/fe_js.html`

**変更内容**:
1. `renderErrors(errors, fileName)` のシグネチャを `renderErrors(errors, warnings, fileName)` に変更。
2. エラーがある場合: エラーをリスト表示 + ボタン `disabled`（従来通り）。
3. アラートがある場合: アラートをリスト表示（`alert-item--warn` クラス）。ボタンは有効のまま。
4. エラーもアラートもある場合: 両方表示し、ボタンは `disabled`（エラー優先）。
5. どちらもない場合: 成功表示（従来通り）。

**表示順**: エラー → アラート

**実装イメージ**:
```javascript
function renderErrors(errors, warnings, fileName) {
  alertList.innerHTML = '';
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings && warnings.length > 0;

  if (hasErrors || hasWarnings) {
    if (hasErrors) resetDropZone();
    else setDropZoneSuccess(fileName || '');

    // エラーを先に表示
    errors.forEach(msg => {
      const li = document.createElement('li');
      li.className = 'alert-item alert-item--error';
      li.innerHTML = '<i class="fa-solid fa-circle alert-icon"></i>' + msg;
      alertList.appendChild(li);
    });
    // アラートを後に表示
    (warnings || []).forEach(msg => {
      const li = document.createElement('li');
      li.className = 'alert-item alert-item--warn';
      li.innerHTML = '<i class="fa-solid fa-triangle-exclamation alert-icon"></i>' + msg;
      alertList.appendChild(li);
    });
    errorCard.classList.remove('hidden');
    btnToConfirm.disabled = hasErrors; // エラーがなければボタン有効
  } else {
    setDropZoneSuccess(fileName || '');
    errorCard.classList.add('hidden');
    btnToConfirm.disabled = false;
  }
}
```

---

### Step 5: バックエンド — 送信時の当月重複チェック

**対象ファイル**: `src/be_main.js`, `src/db_bq_query.js`

**変更内容**:
1. `db_bq_query.js` に新規関数 `hasCurrentMonthInvoice_(wholesalerId)` を追加。
   - `wholesaler_invoices` テーブルを `wholesaler_id` + `created_at` が当月範囲内で `COUNT(*)` 検索。
   - BQクエリ:
     ```sql
     SELECT COUNT(*) AS cnt
     FROM `{dataset}.wholesaler_invoices`
     WHERE wholesaler_id = @wholesalerId
       AND created_at >= TIMESTAMP(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), 'Asia/Tokyo')
       AND created_at < TIMESTAMP(DATE_ADD(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 1 MONTH), 'Asia/Tokyo')
     ```
2. `be_main.js` の `sendInvoiceData()` で、入力バリデーション直後（staging/Drive保存処理の前）に `hasCurrentMonthInvoice_()` を呼び出し、存在すればエラーを返す。

**挿入箇所** (`be_main.js`):
```javascript
if (summaryData.merchantTotals.length === 0) {
  throw new Error('summaryData.merchantTotals が空です');
}
// ← ここに当月重複チェックを挿入
```

**エラーメッセージ**: `今月は既に新規の請求書が登録されています。差し戻しや否認の修正版のアップロードは詳細画面からアップロードしてください。`

---

### Step 6: フロント — 数量の小数許容

**対象ファイル**: `src/fe_js.html`

**変更内容**:
1. `DEFAULT_CSV_COLUMNS_` の `quantity` 定義で `type` を `'integer'` → `'decimal'` に変更。
2. `validateCsv()` の `switch` 文に `case 'decimal'` を追加:
   - 正規表現: `/^-?\d+(\.\d+)?$/`（整数・小数の両方を許容、マイナスも可）
   - `Number()` でパースし `NaN` チェック。
   - `enum` チェックも引き続きサポート（現在 quantity には未使用）。

**追加コード例**:
```javascript
case 'decimal':
  if (val === '' || !/^-?\d+(\.\d+)?$/.test(val.trim())) {
    rowErrors.push(`${rowNum}行目: "${col.csv_header}" は数値で入力してください`);
  } else {
    const num = Number(val);
    if (col.enum && !col.enum.includes(num)) {
      rowErrors.push(`${rowNum}行目: "${col.csv_header}" は ${col.enum.join(' または ')} を入力してください`);
    } else {
      rowObj[key] = num;
    }
  }
  break;
```

---

### Step 7: バックエンド — 数量の SAFE_CAST 対応

**対象ファイル**: `src/be_csv_mapper.js`

**変更内容**:
1. `buildInvoiceLinesSelectSql_()` 内で `type: 'decimal'` の列に対する `SAFE_CAST` を `NUMERIC` に設定。
2. 現状 `type: 'integer'` は `SAFE_CAST(... AS INT64)` を使用しているため、`decimal` 用に分岐を追加:
   ```sql
   SAFE_CAST(col AS NUMERIC) AS quantity
   ```
3. バリデーション条件（`validateCases`）も `decimal` 用に追加（非数値チェック）。

---

## テスト観点

| # | テストケース | 期待結果 |
|---|---|---|
| 1 | 当月未登録の状態でCSVアップロード | バリデーション通過（当月エラーなし） |
| 2 | 当月登録済みの状態でCSVアップロード | エラー表示:「今月は既に新規の請求書が登録されています…」＋送信ボタン `disabled` |
| 3 | 当月登録済み＋別タブで登録後にバックエンドへ直接送信 | バックエンドでエラーレスポンスが返る |
| 4 | 詳細画面の再アップロードモーダル（差し戻し・否認） | 当月制限に関係なくアップロード可能 |
| 5 | 全加盟店の明細がCSVに含まれている | アラートなし |
| 6 | 一部加盟店の明細がCSVに含まれていない | アラート表示:「〇〇店の請求明細がありません。」＋送信ボタンは有効 |
| 7 | エラーとアラートが同時に発生 | 両方表示。エラーが先、アラートが後。送信ボタン `disabled` |
| 8 | 数量に `4.5` を入力したCSV | バリデーション通過、BQに `4.5` が格納される |
| 9 | 数量に `abc` を入力したCSV | バリデーションエラー |
| 10 | 数量に `-3.2` を入力したCSV | バリデーション通過（マイナス小数許容） |
| 11 | 金額フィールドに `-100` を入力 | バリデーション通過（従来通り） |
| 12 | 金額フィールドに `1.5` を入力 | バリデーションエラー（整数のみ） |

---

## UI改修: アップロード画面のファイル表示・ボタン変更

### 変更概要

| 項目 | 変更前 | 変更後 |
|---|---|---|
| キャンセルボタン | あり | **削除** |
| ファイル名表示 | ドロップゾーン内に成功表示として表示 | ドロップゾーンの**下**に「アップロードファイル：ファイル名（サイズ）」として表示 |
| ドロップゾーン（成功時） | アイコン・メッセージが成功表示に変化 | **初期状態のまま**（変化しない） |
| ファイル削除ボタン | なし | ファイル名の横に「🗑 ファイルを削除する」ボタンを新設（処理はキャンセルと同じ `resetPage()`） |

### 対象ファイル

- `src/fe_page_csv_upload.html` — HTML構造変更
- `src/fe_js.html` — `setDropZoneSuccess()` 書き換え、DOM参照変更、イベントリスナー変更
- `src/fe_css.html` — `.file-info` 関連スタイル追加

### 実装詳細

#### HTML変更 (`fe_page_csv_upload.html`)
1. ドロップゾーンの直後に**ファイル情報エリア**を追加（初期 `hidden`）:
   ```html
   <div class="file-info hidden" id="fileInfo">
     <span class="file-info__label">アップロードファイル：</span>
     <span class="file-info__name" id="fileInfoName"></span>
     <button class="btn btn-file-delete" id="btnFileDelete">
       <i class="fa-regular fa-trash-can"></i> ファイルを削除する
     </button>
   </div>
   ```
2. キャンセルボタン（`id="btnCancel"`）を削除。

#### JS変更 (`fe_js.html`)
1. DOM参照: `btnCancel` → `fileInfoEl`, `fileInfoName`, `btnFileDelete` に置き換え。
2. `setDropZoneSuccess(fileName, fileSize)`:
   - ドロップゾーンは `resetDropZone()` で初期状態に戻す。
   - `fileInfoName.textContent` にファイル名＋サイズを設定し、`fileInfoEl` を表示。
3. `resetPage()`: `fileInfoEl.classList.add('hidden')` を追加。
4. `renderErrors()`: エラー時に `fileInfoEl` を非表示化。`fileSize` 引数を追加。
5. `btnFileDelete` のクリックイベント: `resetPage()` を呼び出し。

#### CSS追加 (`fe_css.html`)
```css
.file-info { display: flex; align-items: center; gap: 12px; margin-top: 12px; font-size: 14px; }
.file-info__label { font-weight: 700; }
.btn-file-delete { border: 1px solid #ccc; border-radius: 6px; background: #fff; padding: 6px 14px; font-size: 13px; cursor: pointer; }
.btn-file-delete:hover { background: #f5f5f5; }
```
