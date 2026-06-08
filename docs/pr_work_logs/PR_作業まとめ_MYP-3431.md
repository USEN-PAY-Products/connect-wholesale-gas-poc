# PR 作業まとめ: MYP-3431 確認画面でのバリデーション追加とデザイン反映

## 概要

確認画面（`#confirm`）のデザインリニューアルおよびバリデーション強化を行った。  
加えて、送信成功時のトースト通知を入金予定日付きの詳細メッセージに改善した。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/fe_page_confirm.html` | ヘッダー構造変更、請求月表示追加、モーダル刷新、下部戻るボタン追加 |
| `src/fe_js.html` | 税丸め関数追加、バリデーション追加、ツールチップ動的配置、トースト改善 |
| `src/fe_css.html` | カラム幅調整、色・フォント変更、トーストデザイン刷新、ツールチップスタイル変更 |
| `src/fe_index.html` | トーストHTML構造変更（title/body分離） |

---

## 変更詳細

### 1. 確認画面ヘッダーのデザイン変更

- `summary-card` → `card detail-summary-card` に変更し、詳細画面と同じセクション構造に統一
- 「請求基本情報」タイトルを `detail-summary-title` として表示
- **請求月**を登録日時の横に並列表示（`detail-meta-row--twin` レイアウト）
- 手数料ラベルにツールチップ（`?` アイコン）を追加
  - バルーン色: `#003255`、アイコン色: `#00A7B8`、サイズ: 15×15px

**色・フォント変更:**
- ヘッダー右ボックスの項目名: `#335B77`
- 全値・単位色: `#3C3C3C`
- 合計金額: 数値 32px / 単位 24px
- その他の金額: 16px

### 2. バリデーション追加

#### 2-1. 金額桁数バリデーション（DDL制約ベース）

送信時に BQ テーブルの `NUMERIC` 型制約に基づく桁数チェックを実施。

| 対象 | フィールド | 上限 |
|---|---|---|
| 加盟店単位 | `total_amount`, `subtotal_amount` | 12桁（999,999,999,999） |
| 加盟店単位 | `tax_amount`, `standard_tax_amount`, `reduced_tax_amount` | 11桁（99,999,999,999） |
| 卸全体 | `total_amount`, `fee_amount`, `payment_amount` | 25桁（BigInt使用） |

- 25桁チェックは `Number.MAX_SAFE_INTEGER` を超えるため `BigInt` で比較
- 税内訳 input にはリアルタイム入力制限（`max="99999999999"`、input イベントで強制補正）

#### 2-2. 備考バリデーション

- `<input type="text">` → `<textarea>` に変更（複数行対応）
- `maxlength="250"` 属性 + 送信時の250文字チェック

#### 2-3. 税端数処理

- `roundTax()` 関数を追加
- `sessionStorage` の `shiire_tax_rounding_method` に基づき `floor`/`ceil`/`round` を切り替え
- 確認画面の3箇所の `Math.floor()` を `roundTax()` に置換

#### 2-4. 単価の型変更

- `DEFAULT_CSV_COLUMNS_` の `unit_price` を `integer` → `decimal` に変更（小数単価対応）

### 3. UI/UX 改善

#### 3-1. キャンセルモーダルの刷新

アップロード画面のモーダルと同一デザインに統一:
- `modal--warn` スタイル（警告アイコン付き）
- 右上 × ボタンで閉じる
- メッセージ文言を「一覧に戻ると登録作業中のファイルは削除されますがよろしいですか？」に変更

#### 3-2. トースト通知の改善

- HTML 構造を title + body に分離
- 成功時: チェックアイコン（`fa-circle-check`）、背景 `#EFFCFA`、タイトル色 `#159E85`
- 本文に入金予定日（`business_calendar` の `DEPOSIT` イベントから取得）を表示
- 自動非表示: 8秒（従来4秒）
- 本文スタイル: 16px / `#3C3C3C` / `font-weight: 400` / `line-height: 120%`

#### 3-3. テーブルレイアウト調整

**親テーブル（加盟店一覧）カラム幅:**

| 列 | 幅 |
|---|---|
| 加盟店名 | 304px |
| 顧客ID | 57px |
| 請求金額 | 88px |
| 小計（税抜） | 88px |
| 消費税 | 65px |
| 税内訳（10%） | 105px |
| 税内訳（8%） | 105px |
| 開閉 | 24px |

- `justify-content: space-between`（gap なし）
- 税内訳 input: 89×24px、`font-size: 16px`、`font-family: Noto Sans JP`

**子テーブル（明細）カラム幅:**

| 列 | 幅 |
|---|---|
| 取引日 | 74px |
| 明細項目 | 302px |
| 単価 | 77px |
| 数量 | 35px |
| 明細金額（税抜） | 77px |
| 内 消費税 | 138px |
| 備考 | 320px |

- `border-collapse: collapse`、ヘッダー中央寄せ

#### 3-4. ツールチップ動的配置

JS（IIFE）によるビューポート内自動配置:
- `mouseenter` イベント委譲で `position: fixed` を使用
- 上に十分なスペースがあれば上に、なければ下に表示
- 左右はみ出し防止（8px マージン）
- 備考ラベルにもツールチップを追加

#### 3-5. その他の UI 変更

- 顧客IDに `customer_code` を表示（従来は `mall_code`）
- 下部に「一覧に戻る」ボタンを追加（右寄せ）
- `.page-header` の margin をリセット（0）

---

## 処理フロー

### 送信バリデーションフロー

```mermaid
flowchart TD
    A[送信ボタンクリック] --> B{parsedData / CSV Base64 あり?}
    B -->|No| B1[エラートースト → #upload へ遷移]
    B -->|Yes| C[ローディング表示]
    C --> D{備考 250文字以内?}
    D -->|No| D1[エラートースト表示]
    D -->|Yes| E{加盟店金額 桁数チェック}
    E -->|NG| E1[エラートースト表示]
    E -->|OK| F{卸全体金額 桁数チェック BigInt}
    F -->|NG| F1[エラートースト表示]
    F -->|OK| G[GAS バックエンドへ送信]
    G --> H{送信結果}
    H -->|Success| I[resetPage → #home 遷移]
    I --> J[成功トースト表示 入金予定日付き]
    H -->|Failure| K[エラートースト表示 ボタン復帰]
```

### 消費税丸め処理フロー

```mermaid
flowchart LR
    A[amount_ex_tax × tax_rate ÷ 100] --> B{shiire_tax_rounding_method}
    B -->|floor| C[Math.floor]
    B -->|ceil| D[Math.ceil]
    B -->|round| E[Math.round]
    B -->|未設定| C
```

### 確認画面操作フロー

```mermaid
flowchart TD
    A[確認画面表示] --> B[renderConfirmPage]
    B --> C[サマリー計算 roundTax使用]
    C --> D[加盟店カード描画]
    D --> E{ユーザー操作}

    E -->|税内訳 input 変更| F[リアルタイム桁数チェック]
    F --> G[recalcSummary_ サマリー再計算]
    G --> E

    E -->|備考入力| H[textarea maxlength=250]
    H --> E

    E -->|一覧に戻る| I[キャンセルモーダル表示]
    I -->|戻る| J[resetPage → #upload]
    I -->|×で閉じる| E

    E -->|チェックボックスON| K[送信ボタン有効化]
    K --> L[送信ボタンクリック]
    L --> M[バリデーション → 送信]
```

### トースト表示シーケンス

```mermaid
sequenceDiagram
    participant User as ユーザー
    participant FE as フロントエンド
    participant GAS as GAS バックエンド
    participant BQ as BigQuery

    User->>FE: 送信ボタンクリック
    FE->>FE: バリデーション実行
    FE->>GAS: sendInvoiceData(csv, summary, remarks)
    GAS->>BQ: INSERT / Load Job
    BQ-->>GAS: 成功
    GAS-->>FE: { status: 'success' }
    FE->>FE: resetPage()
    FE->>FE: #home へ遷移
    FE->>FE: _rawScheduleItems から DEPOSIT 日取得
    FE->>User: 成功トースト表示（入金予定日付き、8秒後自動非表示）
```

### ツールチップ配置ロジック

```mermaid
flowchart TD
    A[mouseenter on .detail-meta-help-wrap] --> B[ツールチップ高さ計測]
    B --> C{上に十分なスペースあり?}
    C -->|Yes| D[上に配置 + --above クラス]
    C -->|No| E[下に配置 + --below クラス]
    D --> F{左右はみ出し?}
    E --> F
    F -->|Yes| G[左右位置を補正 8px margin]
    F -->|No| H[中央配置]
    G --> I[position: fixed で表示]
    H --> I
```
