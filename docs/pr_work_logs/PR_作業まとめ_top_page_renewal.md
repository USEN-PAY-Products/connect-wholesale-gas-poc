# TOP画面修正・カレンダー表示変更 作業まとめ

## 概要

TOP画面のレイアウト刷新とカレンダー表示方式の変更を実施。  
請求履歴をテーブル形式に変更し、カレンダーをモーダル化。  
Copilot レビュー指摘（アクセシビリティ・コーディング規約）への対応も合わせて実施。

- **ブランチ:** `feature/top-page-renewal`
- **PR:** [#15 TOP画面修正、カレンダー表示変更](https://github.com/USEN-PAY-Products/connect-wholesale-gas-poc/pull/15)
- **主要変更ファイル:**
  - `src/fe_page_home.html`
  - `src/fe_index.html`
  - `src/fe_part_header.html`
  - `src/fe_css.html`
  - `src/fe_js.html`
  - `src/db_bq_query.js`
  - `src/be_invoice.js`

---

## 変更内容

### 1. ヘッダーボタン変更

- CSVテンプレートダウンロードボタン（`btn-template-dl`）を**カレンダースケジュールボタン**（`btn-calendar-open`）に置換
- カレンダーボタンはホーム画面・詳細画面でのみ表示（`navigate()` で制御）

### 2. カレンダーのモーダル化

- カレンダーを `#pageHome` 内のインライン表示から **モーダルオーバーレイ**に変更
- モーダルは `#pageHome` の外（`fe_index.html` の `<body>` 直下）に配置し、全ページから利用可能
- ヘッダーのスケジュールボタンクリックで開閉
- アクセシビリティ対応:
  - `role="dialog"` / `aria-modal="true"` / `aria-labelledby` 属性
  - フォーカス転送（開くとモーダル内にフォーカス移動）
  - フォーカストラップ（Tab/Shift+Tab がモーダル内で循環）
  - Escape キーで閉じる
  - 閉じた後にフォーカスを元のボタンに復帰

### 3. カレンダーUI改善

- **色帯表示（カラーバンド）**: 日付セル内にバッジではなく連続する色帯で期間を表現
  - 期間の開始・中間・終了で `border-radius` を変えて繋がりを表現
  - 色帯に `title` / `aria-label` でイベント説明をツールチップ・スクリーンリーダー対応
- **月選択パネル（Month Picker）**: カレンダー内のアイコンクリックで4×3グリッドの月選択パネルを表示
  - 年ナビゲーション（`< 年 >`）付き
- **凡例**: 4種のイベントタイプに対応（請求書アップロード期間 / 加盟店異議申立・修正期間 / 請求額確定日 / ご入金日）
- **中央表示**: モーダルを画面中央に配置

### 4. 請求履歴のテーブル化

- カード形式からテーブル形式（`<table>`）に変更
- 列構成: 請求月 / 登録日時 / 請求金額 / 手数料（税込）/ 差戻し有無 / 否認有無 / 詳細リンク
- ページネーション削除（全件表示）
- ステータスバッジ: 差戻し（`#FF7846`）/ 否認（`#DF4C4C`）/ なし（`#B4B4B4`）

### 5. BQ クエリ改修

#### `fetchInvoicesByWholesaler_`（請求一覧）

- CTE + `ROW_NUMBER()` で親子関係のある請求の**最新バージョン**のみ表示
  - `COALESCE(wholesaler_invoice_id, id) AS root_id` でグルーピング
  - `ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY created_at DESC)` で最新を取得
- `store_invoices` と LEFT JOIN し、差戻し（`RETURNED`）・否認（`DISPUTED`）フラグを取得
  - `has_resubmit`: 差戻しあり（0/1）
  - `has_denial`: 否認あり（0/1）
- JOIN キーを `wi.root_id`（親ID）で結合（子IDだと store_invoices と紐付かない）
- `created_at` は日付のみフォーマット（`FORMAT_TIMESTAMP('%Y/%m/%d')`）

#### `fetchBusinessCalendar_`（新規追加）

- `business_calendar` テーブルから直接取得（モックデータ廃止）
- 対象イベントタイプ: `WHOLESALER_INVOICE_STORAGE` / `WHOLESALER_INVOICE_FIXATION` / `DEPOSIT` / `OBJECTION_PERIOD`
- `is_visible_to_wholesaler = TRUE` でフィルタ
- パラメータクエリ使用

### 6. バックエンド変更

- `be_invoice.js`: `getMockScheduleData()` / `MOCK_SCHEDULE_` を削除し、`fetchScheduleData()` に置換
  - `getServerAccountInfo_()` でアカウント情報取得 → `fetchBusinessCalendar_()` でBQ直接クエリ

### 7. コード品質対応

- `var` → `const` / `let` に全件修正（コーディング規約準拠）
- `.visually-hidden` ユーティリティクラス追加

---

## 主要なスタイル変更

| 要素 | 変更内容 |
|---|---|
| `.btn-calendar-open` | 白背景・角丸・シャドウのヘッダーボタン |
| `.billing-history-table thead` | 背景 `#CCD6DD`、文字色 `#335B77` |
| `.badge--resubmit` | `#FF7846`（差戻し） |
| `.badge--denial` | `#DF4C4C`（否認） |
| `.badge--none` | `#B4B4B4` 白文字（なし） |
| `.cal-band` | 色帯（position-based border-radius で連結表現） |
| `.cal-month-picker` | 4×3グリッド + 年ナビ |
| `.btn-detail-link` | `#00A7B8`、16px |
| `.calendar-modal-overlay` | `align-items: center; justify-content: center`（中央表示） |

---

## バグ修正

| 問題 | 原因 | 対応 |
|---|---|---|
| `FORMAT_TIMESTAMP` の `%` でGAS clasp push失敗 | ダブルエスケープ `\\'` | シングルエスケープ `\'` に修正 |
| 詳細ページからカレンダーが開かない | イベントリスナーが `initHomePage()` 内 | グローバル IIFE に移動 |
| `calOverlay` ReferenceError | IIFE スコープ外から参照 | `document.getElementById()` でローカル取得 |
| `store_invoices` JOIN で紐付かない | 子ID（latest）で JOIN していた | `root_id`（親ID）で JOIN に修正 |
| 親請求が古い金額を表示 | `wholesaler_invoice_id IS NULL` で親のみ取得 | CTE + ROW_NUMBER で最新バージョン表示 |
| 色帯のツールチップが空 | `ev.description` 参照だが保存キーは `title` | `ev.title` に統一 |
| `#pageHome` 非表示時にモーダルも隠れる | モーダルが `#pageHome` 内 | `fe_index.html` の `<body>` 直下に移動 |

---

## 対応しなかった指摘（PoCスコープ外）

| 指摘内容 | 判断理由 |
|---|---|
| 詳細ページ直接アクセス時のカレンダーナビ未登録 | 実利用フローではTOP→詳細の順に遷移するため問題なし |
| `created_at` に時刻を含める | 同日複数登録のケースは現時点で想定不要 |
| 4つ以上のイベントが同日に重なった場合の色帯オフセット | 月1つずつのデータしかないため重なりは発生しない |
