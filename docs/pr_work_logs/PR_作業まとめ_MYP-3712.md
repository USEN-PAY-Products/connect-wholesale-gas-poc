# PR 作業まとめ: MYP-3712【卸】取り下げ済みのフィールド作成

## 概要

詳細画面に「取下げ済みの請求一覧」セクションを新設し、WITHDRAWN ステータスの加盟店請求を否認セクションから分離して独立表示する。  
また、取下げを取り消す機能（WITHDRAWN → DISPUTED に戻す）を追加し、誤操作時にリカバリー可能とした。

### 追加対応

本チケット実装の過程で発見された以下の課題にも対応:

1. **金額再計算**: 取下げ / 取下げ取り消し時に `wholesaler_invoices` の合計金額を再計算した新版を INSERT
2. **`wholesaler_invoice_date` の引き継ぎ**: 再送信時に `CURRENT_DATE` ではなくルート WI の日付を引き継ぐ
3. **異議申立期間（OBJECTION_PERIOD）チェック**: 期間終了後は「取下げをやめる」を無効化

## 対象ブランチ

`feature/MYP-3712-add-withdrawn-field` → `develop`

---

## 変更ファイル一覧

| ファイル | 変更種別 | 変更内容 |
|----------|---------|---------|
| `src/fe_page_detail.html` | 変更 | 「取下げ済みの請求一覧」セクション HTML 追加、取下げ取り消し確認モーダル追加、既存取下げ確認モーダルの文言修正・aria属性追加 |
| `src/fe_js.html` | 変更 | WITHDRAWN フィルタ分離、取下げ済みアコーディオン描画、取下げ取り消しイベントハンドラ追加、OBJECTION_PERIOD によるボタン disabled 制御、モック削除・防御的 else 追加 |
| `src/fe_page_error.html` | 変更 | 「ログインページに戻る」リンク（`error-page__footer`）を削除（本プロジェクトではログインページを用意しないため） |
| `src/fe_css.html` | 変更 | 取下げ取り消しボタンスタイル、合意内容読取専用スタイル、モーダルスタイル（オレンジテーマ）、異議申立期間終了メッセージスタイル追加。エラー画面のログインリンク関連スタイル削除 |
| `src/be_invoice.js` | 変更 | `withdrawStoreInvoice` / `undoWithdrawStoreInvoice` をトランザクション + 金額再計算に全面書き換え、OBJECTION_PERIOD チェック追加、再送信関数の `wholesaler_invoice_date` 引き継ぎ |
| `src/be_csv_mapper.js` | 変更 | マッピング再送信関数（個別・一括）の `wholesaler_invoice_date` 引き継ぎ |
| `src/db_bq_query.js` | 変更 | `fetchStoreInvoiceForWithdraw_` / `fetchObjectionPeriodEndDate_` 新規追加、`fetchLatestWholesalerInvoice_` に `wholesaler_invoice_date` 追加、`fetchInvoiceDetailSummary_` に `objection_end_at`（business_calendar JOIN）追加 |
| `.github/workflows/deploy.yml` | 変更 | Google 審査対応のため自動デプロイを一時停止（コメントアウト） |

---

## 設計方針

### WITHDRAWN の分離

| Before | After |
|--------|-------|
| WITHDRAWN は否認（disputed）フィルタに含まれ、同セクション内に「取下げ済み」バッジ表示 | WITHDRAWN を独立カテゴリとして分離し、専用の「取下げ済みの請求一覧」セクションに表示 |

### セクション配置

```
┌─────────────────────────────┐
│ 要対応の請求一覧             │  ← 差戻し / 否認差戻し
├─────────────────────────────┤
│ 確認中・承認済みの請求一覧   │  ← PENDING_CONFIRMATION / APPROVED
├─────────────────────────────┤
│ 取下げ済みの請求一覧         │  ← WITHDRAWN（新設）
└─────────────────────────────┘
```

### 取下げ → 取り消しフロー

```
DISPUTED → [請求取り下げ] → WITHDRAWN → [取下げをやめる] → DISPUTED
```

- 両操作ともカスタム確認モーダルで意思確認後に実行
- 成功時はページリロード + トースト通知
- 取下げ / 取消し時に `wholesaler_invoices` の合計金額を再計算（新版 INSERT）
- 影響行数 0（楽観ロック相当）は業務バリデーションとして `error_()` を返却
- OBJECTION_PERIOD 終了後は取消し不可（BE で拒否 + FE でボタン disabled）

---

## 変更詳細

### 1. HTML

#### `fe_page_detail.html`

#### 新セクション追加

```html
<section class="detail-section hidden" id="detailWithdrawnSection">
  <h2>取下げ済みの請求一覧</h2>
  <p>以下の請求は、差戻／否認差戻後に取下げされた請求です。対応は不要です。</p>
  <div id="detailWithdrawnList"></div>
</section>
```

#### 取下げ取り消し確認モーダル

- `#undoWithdrawConfirmModal` を新設
- `aria-labelledby` / `aria-describedby` でアクセシビリティ対応
- 既存 `#withdrawConfirmModal` も同様に aria 属性追加

#### 取下げ確認モーダル文言修正

- 「この操作は、戻すことができません。」を削除（取り消し機能の追加に伴い不正確となるため）
- 取下げ後の案内を「取下げ済みの請求一覧から再度請求を行ってください。」に変更

#### `fe_page_error.html`

- 「ログインページに戻る」リンク（`error-page__footer` ブロック）を削除
- 本プロジェクトではログインページを用意しないため、遷移先が存在しない不要な UI を除去

### 2. JavaScript（`fe_js.html`）

#### フィルタリングロジックの変更

`renderDetailStoreList_` で 4 分類に分離:

| カテゴリ | 条件 |
|----------|------|
| `returned` | `RETURNED` かつ `invoice_status` が DISPUTED / WITHDRAWN 以外 |
| `disputed` | MCR/RETURNED/PENDING_REVIEW + DISPUTED（**WITHDRAWN を除外**） |
| `withdrawn` | `invoice_status === 'WITHDRAWN'` |
| `normal` | 上記いずれにも該当しない |

#### 取下げ済みアコーディオン（`buildDetailAccordion_`）

- `isWithdrawn` フラグ追加
- 合意内容の読取専用表示（`.backoffice-remark__handover-readonly`）
- 「取下げをやめる」ボタン（`data-action="undo-withdraw"`）
- OBJECTION_PERIOD 終了時はボタンを `disabled` + 「異議申立期間が終了しています」メッセージ表示
- 備考欄は読取専用

#### OBJECTION_PERIOD によるボタン制御

```javascript
// renderDetailPage_ でサマリーから objection_end_at を取得
_objectionEndAt = (data.summary && data.summary.objection_end_at) || null;

// buildDetailAccordion_ の isWithdrawn 分岐で判定
const today = new Date(); today.setHours(0,0,0,0);
const periodExpired = _objectionEndAt && new Date(_objectionEndAt) < today;
// periodExpired → disabled ボタン + 赤字メッセージ
```

#### 取下げ取り消しイベントハンドラ

- カスタムモーダルで確認 → `executeUndoWithdraw_()` を呼び出し
- `google.script.run.undoWithdrawStoreInvoice()` で BE に送信
- 成功時: `_detailPendingToastMsg` にメッセージをセットし、ページリロード
- `initDetailPage` 完了後にトーストを表示（ローディング中のトースト表示を防止）

#### 取下げ成功時の挙動変更

- Before: DOM 操作でバッジ切り替え（セクション移動なし）
- After: `_detailCurrentInvoiceId = null` + `initDetailPage()` でリロード → 取下げ済みセクションに移動

#### モック分岐の削除

- `google.script.run` が利用不可の場合、モック処理ではなくユーザーへのエラー通知 + ボタン状態復元に変更

#### `_detailPendingToastMsg` パターン

```javascript
// 取下げ / 取り消し成功時にセット
_detailPendingToastMsg = '請求を取り下げました。';
_detailCurrentInvoiceId = null;
initDetailPage(parentInvoiceId);

// initDetailPage の successHandler 内で表示
if (pendingToastMsg) showToast(pendingToastMsg, 'success');
```

### 3. CSS（`fe_css.html`）

| セレクタ | 用途 |
|----------|------|
| `.backoffice-remark__handover-readonly` | 取下げ済みの合意内容（読取専用テキスト） |
| `.detail-action-btn--undo-withdraw` | 「取下げをやめる」ボタン（専用サイズ・padding） |
| `.detail-action-btn__period-expired-msg` | 異議申立期間終了メッセージ（赤字 12px） |
| `#undoWithdrawConfirmModal .modal--warn` | 取下げ取り消しモーダル（オレンジテーマ） |

#### モーダルテーマ（オレンジ系）

```css
background: #FFF1EC;
border-color: #FFB499;
.modal__title--warn { color: #FF7846; }
```

#### 削除・リネーム

- `.detail-action-badge--withdrawn` → 削除（JS から参照がなくなったため）
- 重複していた `.detail-action-badge--resubmitted` を整理
- `.error-page__footer` / `.error-page__back-link` / `.error-page__back-link:hover` → 削除（エラー画面のログインリンク廃止に伴い不要）

### 4. バックエンド（`be_invoice.js`）

#### `withdrawStoreInvoice` / `undoWithdrawStoreInvoice` の全面書き換え

両関数ともトランザクション SQL + INSERT-SELECT で金額再計算を行うように変更:

```
処理フロー（共通）:
1. fetchStoreInvoiceForWithdraw_()  → store 存在・ステータス確認
2. fetchLatestWholesalerInvoice_()  → 最新 WI 取得
3. [undoのみ] fetchObjectionPeriodEndDate_() → 異議申立期間チェック
4. BEGIN TRANSACTION
     UPDATE store_invoices SET invoice_status = ...
     INSERT INTO wholesaler_invoices (INSERT-SELECT で金額再計算)
   COMMIT
```

金額再計算ロジック:
- **取下げ**: `新WI金額 = 最新WI − 取下げstore`
- **取消し**: `新WI金額 = 最新WI + 戻すstore`
- `invoice_fee_amount` = `FLOOR(新total × fee_rate / 100)`
- `payment_amount` = `新total − 新fee`

#### OBJECTION_PERIOD チェック（`undoWithdrawStoreInvoice`）

```javascript
const periodRow = fetchObjectionPeriodEndDate_(wholesalerId, latestWi.wholesaler_invoice_date);
if (periodRow && periodRow.end_at) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  if (String(periodRow.end_at) < today) {
    return error_('異議申立期間が終了しているため、取下げの取り消しはできません。');
  }
}
```

#### `wholesaler_invoice_date` の引き継ぎ（再送信関数）

| 関数 | 修正前 | 修正後 |
|------|--------|--------|
| `buildTransactionSql_`（初回） | `CURRENT_DATE` | **変更なし** |
| `buildResubmitTransactionSql_` | `CURRENT_DATE` | `latestWi.wholesaler_invoice_date` |
| `buildBulkResubmitTransactionSql_` | `CURRENT_DATE` | `latestWi.wholesaler_invoice_date` |

#### `be_csv_mapper.js`（マッピング再送信関数）

| 関数 | 修正前 | 修正後 |
|------|--------|--------|
| `buildMappedTransactionSql_`（初回） | `CURRENT_DATE` | **変更なし** |
| `buildMappedResubmitTransactionSql_` | `CURRENT_DATE` | `latestWi.wholesaler_invoice_date` |
| `buildMappedBulkResubmitTransactionSql_` | `CURRENT_DATE` | `latestWi.wholesaler_invoice_date` |

#### `undoWithdrawStoreInvoice` 新規追加

```javascript
function undoWithdrawStoreInvoice(storeInvoiceId, parentInvoiceId) {
  // 1. バリデーション: UUID 形式チェック
  // 2. fetchStoreInvoiceForWithdraw_() → WITHDRAWN ステータス確認
  // 3. fetchLatestWholesalerInvoice_() → 最新 WI 取得
  // 4. fetchObjectionPeriodEndDate_() → 異議申立期間チェック（終了済みなら error_()）
  // 5. BEGIN TRANSACTION
  //      UPDATE store_invoices SET invoice_status = 'DISPUTED'
  //      INSERT INTO wholesaler_invoices（金額 = 最新WI + 戻すstore）
  //    COMMIT
  // 6. return success_(...)
}
```

#### エラーハンドリング方針

| ケース | 処理 |
|--------|------|
| 更新対象なし（`affected === 0`） | `return error_(...)` → FE の `successHandler` で日本語アラート表示 |
| BQ エラー等の予期しない例外 | `throw` → FE の `failureHandler` に流れる |

`throw` を使わず `error_()` を返す理由:  
`catch` で `"undoWithdrawStoreInvoice failed: ..."` が付与されると、フロントのアラート文言が技術的になりユーザー向けメッセージが損なわれるため。

### 5. DB クエリ（`db_bq_query.js`）

#### `fetchStoreInvoiceForWithdraw_` 新規追加

取下げ / 取消し時の事前バリデーション用。対象 store_invoices の存在・ステータスを確認する。

```javascript
function fetchStoreInvoiceForWithdraw_(storeInvoiceId, parentInvoiceId, wholesalerId, expectedStatus) {
  // WHERE id = ? AND wholesaler_invoice_id = ? AND wholesaler_id = ?
  //   AND is_latest = TRUE AND invoice_status = expectedStatus
}
```

#### `fetchObjectionPeriodEndDate_` 新規追加

異議申立期間（OBJECTION_PERIOD）の `end_at` を取得する。

```javascript
function fetchObjectionPeriodEndDate_(wholesalerId, wholesalerInvoiceDate) {
  // SELECT end_at FROM business_calendar
  // WHERE wholesaler_id = ? AND event_type = 'OBJECTION_PERIOD'
  //   AND year_month = DATE_TRUNC(wholesaler_invoice_date, MONTH)
}
```

#### `fetchLatestWholesalerInvoice_` 変更

SELECT に `wholesaler_invoice_date` を追加。再送信時の日付引き継ぎおよび OBJECTION_PERIOD 判定に使用。

#### `fetchInvoiceDetailSummary_` 変更

`business_calendar` テーブルを LEFT JOIN し、`objection_end_at` を返却するよう変更。

```sql
SELECT wi.*, bc.end_at AS objection_end_at
FROM wholesaler_invoices AS wi
LEFT JOIN business_calendar AS bc
  ON bc.wholesaler_id = wi.wholesaler_id
  AND bc.event_type = 'OBJECTION_PERIOD'
  AND bc.year_month = DATE_TRUNC(wi.wholesaler_invoice_date, MONTH)
WHERE ...
```

---

## アクセシビリティ対応

| 対象 | 対応内容 |
|------|---------|
| `#withdrawConfirmModal` | `aria-labelledby="withdrawConfirmTitle"` / `aria-describedby="withdrawConfirmDesc"` 追加 |
| `#undoWithdrawConfirmModal` | `aria-labelledby="undoWithdrawConfirmTitle"` / `aria-describedby="undoWithdrawConfirmDesc"` 追加 |

---

## コーディングルール準拠

| ルール | 対応 |
|--------|------|
| `var` 禁止 → `const` / `let` 使用 | ✅ 全箇所 `const` / `let` を使用 |
| 内部関数は末尾 `_` | ✅ `executeWithdraw_` / `executeUndoWithdraw_` / `fetchStoreInvoiceForWithdraw_` / `fetchObjectionPeriodEndDate_` |
| `function` キーワードで定義 | ✅ アロー関数未使用（BE） |
| モック分岐を本番コードに残さない | ✅ 削除し、防御的 `else` に置換 |
| BQ ↔ GAS 往復の最小化 | ✅ INSERT-SELECT でトランザクション内完結 |

---

## 影響範囲

- **機能影響**: 詳細画面のみ。WITHDRAWN の表示位置が否認セクション → 独立セクションに移動。新規「取下げをやめる」機能を追加。エラー画面から「ログインページに戻る」リンクを削除（本プロジェクトではログインページを用意しないため）。OBJECTION_PERIOD 終了後は「取下げをやめる」ボタンが disabled + メッセージ表示。
- **データ影響**: `store_invoices.invoice_status` の更新 + `wholesaler_invoices` への新版 INSERT（金額再計算）。テーブル構造の変更なし。
- **再送信への影響**: 個別・一括再送信時の `wholesaler_invoice_date` が `CURRENT_DATE` → ルート WI の日付引き継ぎに変更。請求対象月が再送信のたびに変わる問題を修正。
- **既存機能への影響**: 否認セクションのフィルタから WITHDRAWN を除外したため、否認セクションには DISPUTED ステータスのみが表示される。バリデーション（`_detailActionRequiredMallCodes`）も WITHDRAWN 除外済み。
- **デプロイ**: GitHub Actions の自動デプロイを一時停止中（Google 審査対応）。手動 `npm run push:dev` でデプロイ。
