# MYP-3688 カレンダー表示デザイン反映

## 概要

ヘッダーのカレンダーアイコンから開くカレンダーモーダルのデザインを刷新し、`business_calendar` テーブルのイベント情報を視覚的に表示するようにした。

---

## 変更内容

### 1. カレンダーセルの背景色表示

- `business_calendar.display_color_code` の色をカレンダーセルの背景に反映
- 複数イベントが同日に重なる場合は `linear-gradient` で表示
- イベント期間の開始・終了に応じてセルに `border-radius` を付与（`.cal-cell--start` / `--end` / `--single` / `--middle`）

### 2. イベントラベル表示

- `event_description` テキストをセル内に `.cal-event-label` として表示
- ラベルは `start` または `single` のセル、および週の先頭（日曜）に表示
- 複数日にまたがるイベントは `width: calc(span * 100%)` でセルを横断表示

### 3. 凡例（レジェンド）の削除

- `fe_index.html` から `.calendar-legend` HTML を削除
- `fe_css.html` から `.calendar-legend` / `.cal-band` / `.cal-badge` 関連スタイルを削除

### 4. 月ピッカーのオーバーレイ化

- 月選択UIを `position: absolute` で月ラベルの直下にオーバーレイ表示
- ピッカー外クリック・Escape キーで閉じる
- リスナーのリーク防止のため `_removePickerListeners()` を実装

### 5. カレンダーヘッダーのデザイン変更

- ナビゲーションボタンを半円形（semicircle）に変更し、月ラベルボックスに密着配置
- 月ラベル: `border: 1.5px solid #D7D7D7`、231×40px
- ナビボタン: ボーダー `#D7D7D7`、テキスト色 `#00A7B8`
- ピッカーナビ: `border-radius: 50%`

### 6. レスポンシブ対応

- `.calendar-modal`: width 866px、`max-width: calc(100vw - 32px)`、`max-height: calc(100vh - 80px)`
- `.calendar-grid`: `gap: 2px 0`、`grid-auto-rows: minmax(72px, auto)`

### 7. ヘッダーロゴのリンク化

- `fe_part_header.html`: ロゴを `<a href="#home" class="header-logo-link">` で囲み、クリックでホームに遷移

### 8. タブタイトル変更

- `be_main.js`: `.setTitle('仕入れコネクト')`

### 9. コピーライト変更

- `fe_page_home.html` / `fe_page_detail.html` / `fe_page_csv_upload.html`: フッターのコピーライトを `USEN PAY Co.,Ltd.` に変更

### 10. コーディング規約対応

- `var` → `const` / `let` に置換（`fe_js.html` カレンダー関連セクション）
- 閉じるボタンに `:focus-visible` outline を追加（アクセシビリティ）

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/fe_js.html` | カレンダー描画ロジック全面改修（`buildCellBackground`, `getCellPosClass`, `renderCalendar` 等） |
| `src/fe_css.html` | カレンダー関連スタイル全面改修（セル背景、ラベル、ピッカー、ヘッダーナビ等） |
| `src/fe_index.html` | `.calendar-legend` 削除 |
| `src/fe_part_header.html` | ロゴリンク化 |
| `src/fe_page_home.html` | コピーライト変更 |
| `src/fe_page_detail.html` | コピーライト変更 |
| `src/fe_page_csv_upload.html` | コピーライト変更 |
| `src/be_main.js` | タブタイトル変更 |
| `docs/plan/calendar_design_fix.md` | デザイン設計ドキュメント |

---

## 技術的な注意点

- GAS の `HtmlService.createHtmlOutputFromFile()` はネストしたテンプレートタグ（`<?!= ?>`）を処理しないため、フッターのpartial化は断念しインラインで記述
- `scheduleMap` のエントリに `endDate` を追加し、ラベルの横断幅計算に使用
- 月ピッカーの `position: absolute` は親要素（`.cal-month-label`）に `position: relative` を設定して基準を確定
