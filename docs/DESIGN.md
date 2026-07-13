# DESIGN.md - フロントエンド設計定義書

> **最終更新**: 2026-06-08  
> **対象**: `src/fe_css.html` (3177行) に基づく実装仕様

---

## 1. デザインコンセプト & 共通仕様

PC 向けの業務管理画面。視認性と操作性を重視したクリーンな UI を提供する。  
SPA（Single Page Application）構成で、ハッシュルーターにより画面を切り替える。

### 1.1 レイアウト

| 項目 | 値 |
|------|-----|
| ヘッダー最小幅 | `1280px` |
| コンテンツ幅 (`.main-content`) | `1248px` (左右 auto マージンで中央配置) |
| コンテンツ上パディング | `24px` |
| ベース背景色 | `#F8F8F9` |

```
┌─────────────────────────────────────────────────────────┐
│  site-header  (固定高さ 80px, 背景 #1a2b4a)            │
├─────────────────────────────────────────────────────────┤
│  toast (fixed, top:96px, z-index:100)                   │
├─────────────────────────────────────────────────────────┤
│              main-content  (1248px 中央)                 │
│  ┌─────────────────────────────────────────────────┐    │
│  │  page-header (タイトル + アクションボタン)        │    │
│  ├─────────────────────────────────────────────────┤    │
│  │  page body (各画面固有コンテンツ)                 │    │
│  └─────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│  site-footer  (中央配置テキスト)                         │
└─────────────────────────────────────────────────────────┘
```

### 1.2 リセット / ベーススタイル

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Noto Sans JP', 'Hiragino Sans', sans-serif; font-size: 14px; }
```

### 1.3 ユーティリティクラス

| クラス | 用途 |
|--------|------|
| `.hidden` | `display: none !important` で非表示 |
| `.visually-hidden` | スクリーンリーダー用の非表示（clip） |

---

## 2. スタイルガイド (Style Guide)

### 2.1 タイポグラフィ (Typography)

* **フォントファミリー**: `'Noto Sans JP', 'Hiragino Sans', sans-serif`
* **ウェイト**: 400 (Regular), 600 (SemiBold), 700 (Bold)

| 用途 | サイズ | ウェイト | 実装箇所 |
|------|--------|----------|----------|
| body ベース | 14px | 400 | `body` |
| 補足テキスト・ラベル | 12-13px | 400 | `.summary-block__label`, `.alert-item` |
| 標準テキスト | 14-16px | 400 | `.toast-body`, `.detail-meta-value` |
| セクションタイトル | 18px | 700 | `.card-label`, `.detail-upload-modal__title` |
| コンテンツタイトル | 24px | 400 | `.detail-section-title`, `.home-section-title` |
| ページタイトル | 28px | 400 | `.page-title` |
| ヘッダーロゴ | 32px | 700 | `.header-logo` |
| 強調金額 | 32px | 400 | `.confirm-amount-row--total .summary-value-display` |

### 2.2 カラーパレット (Color Palette)

#### テキストカラー

| トークン | カラーコード | 用途 |
|----------|-------------|------|
| `text-main` | `#3C3C3C` | メインテキスト（Toast, ボタン内テキスト） |
| `text-body` | `#333` | body テキスト, テーブルセル |
| `text-sub` | `#555` / `#666` | サブテキスト, ラベル |
| `text-muted` | `#888` / `#9C9C9C` | プレースホルダー, 無効テキスト |
| `text-heading` | `#335B77` | テーブルヘッダー, セクションタイトル |
| `text-accent` | `#00A7B8` | テキストリンク, アイコン |
| `text-error` | `#DF4C4C` | エラーテキスト |
| `text-navy` | `#1a2b4a` | 金額値, 強調テキスト |

#### 背景色

| トークン | カラーコード | 用途 |
|----------|-------------|------|
| `bg-base` | `#F8F8F9` | ページ全体の背景 |
| `bg-note` | `#F1F2F3` | アコーディオン本体, ノート背景 |
| `bg-contents` | `#EAEBED` | テーブルヘッダー |
| `bg-header-table` | `#CCD6DD` | 請求履歴テーブル thead / 加盟店リストヘッダー |
| `bg-card` | `#FFFFFF` | カード, モーダル |
| `bg-header` | `#1a2b4a` | サイトヘッダー |
| `bg-btn-primary` | `#1a2b4a` | メイン送信ボタン |
| `bg-btn-sub` | `#00A7B8` | サブボタン（戻る, 取下げやめる等） |
| `bg-btn-danger` | `#e53935` / `#DF4C4C` | 危険ボタン |
| `bg-disabled` | `#C7C7C7` / `#b0bec5` | 非活性ボタン |
| `bg-modal-overlay` | `rgba(0,0,0,0.45)` | モーダルオーバーレイ |
| `bg-loading` | `rgba(255,255,255,0.85)` | ローディングオーバーレイ |

#### ステータスカラー

| トークン | 背景 | テキスト/ボーダー | 用途 |
|----------|------|-------------------|------|
| `status-pending` | `#EFEFF9` | `#6464C3` | 未検閲 / 確認中 |
| `status-returned` | `#FFFEEF` | `#3C3C3C` (icon: `#FF7846`) | 差戻し |
| `status-disputed` | `#FFE4E4` | `#3C3C3C` (icon: `#DF4C4C`) | 否認 |
| `status-approved` | `#CDF6EF` | `#159E85` | 承認 / 取り下げ済 |
| `status-resubmit` | `#FF7846` | `#FFF` | 要再提出（一覧バッジ） |
| `status-denial` | `#DF4C4C` | `#FFF` | 否認（一覧バッジ） |

#### Toast カラー

| 種別 | 背景 | ボーダー | テキスト |
|------|------|----------|----------|
| エラー | `#FFF0F0` | `#DF4C4C` | `#DF4C4C` |
| 成功 | `#EFFCFA` | `#2e7d32` | `#159E85` |

#### 罫線

| 用途 | カラーコード |
|------|-------------|
| 汎用ボーダー | `#D9D9D9` |
| 軽めの区切り | `#E0E0E0` / `#E8E8E8` |
| テーブル行線 | `#EBEBEB` / `#F0F0F0` |
| ダッシュ線 | `#E0E0E0`（`border-top: 1px dashed`） |

---

## 3. UIコンポーネント定義

### 3.1 ボタン (Buttons)

#### メインボタン (`.btn-submit`)
送信・確定系のプライマリアクション。pill 型。

| 状態 | 背景 | 文字色 | サイズ |
|------|------|--------|--------|
| 活性 | `#1a2b4a` | `#fff` | h48, px80, font18, radius24 |
| hover | `#263d6b` | `#fff` | - |
| 非活性 | `#C7C7C7` | `#fff` | `cursor: not-allowed` |

#### サブボタン (`.btn-back`)
戻る系のセカンダリアクション。pill 型。

| 状態 | 背景 | 文字色 | サイズ |
|------|------|--------|--------|
| 活性 | `#00A7B8` | `#fff` | h48, px40, font18, radius24 |
| hover | `#0096a5` | `#fff` | - |

#### FAB ボタン (`.btn-fab`)
トップ画面の「新規請求登録」。影あり pill 型。

| 状態 | 背景 | 文字色 | サイズ |
|------|------|--------|--------|
| 活性 | `#1a2b4a` | `#fff` | h52, px28, font18, radius26 |
| hover | `#263d6b` | `#fff` | 影強調 |

#### 危険ボタン (`.btn-danger`, `.btn-danger-outline`)

| バリエーション | 背景 | ボーダー | 文字色 |
|----------------|------|----------|--------|
| solid | `#e53935` | なし | `#fff` |
| outline | 透明 | `#DF4C4C` | `#DF4C4C` |

#### キャンセルボタン (`.btn-cancel-confirm`)
確認画面のキャンセルアクション。

| 状態 | 背景 | ボーダー | 文字色 | サイズ |
|------|------|----------|--------|--------|
| 活性 | transparent | `#e53935` | `#e53935` | h48, px40, radius24 |
| hover | `#fff5f5` | - | - | - |

#### アクションボタン (`.backoffice-remark__actions .btn`)
否認セクション内の「修正ファイルアップロード」等。

| 状態 | 背景 | ボーダー | 文字色 | サイズ |
|------|------|----------|--------|--------|
| 活性 | `#FFF` | `#D9D9D9` | inherit | w197, h36, radius40 |
| hover | `#f5f5f5` | - | - | - |

#### ファイル選択ボタン (`.btn-select-file`)
ドロップゾーン内のファイル選択。

| 状態 | 背景 | ボーダー | サイズ |
|------|------|----------|--------|
| 活性 | `#FFF` | `#D9D9D9` | h36, px32, radius40 |
| hover | `#f5f5f5` | - | - |

### 3.2 カード (Cards)

| クラス | 用途 | スタイル |
|--------|------|----------|
| `.card` | 汎用カード | 白背景, radius10, p24x28, shadow |
| `.main-card` | メイン白カード（upload等） | flex-col, p28, gap24 |
| `.summary-card` | 確認画面サマリー | 白背景, radius8, p24x28, shadow |
| `.detail-summary-card` | 詳細画面サマリー | p24x28 |
| `.detail-section` | 詳細画面セクション | 白背景, radius8, p16, shadow |

### 3.3 Toast 通知

固定位置（`top: 96px`, 中央配置）のバナー型通知。

```
┌────────────────────────────────────────────────────┐
│ [icon]  タイトル（Bold 16px）  本文（Regular 16px）  ×│
└────────────────────────────────────────────────────┘
```

| プロパティ | 値 |
|------------|-----|
| 幅 | `calc(100% - 64px)`, max `1200px` |
| radius | `6px` |
| shadow | `0 2px 8px rgba(0,0,0,.15)` |
| z-index | `100` |
| 消去 | 右上の `×` ボタン |

### 3.4 モーダル

#### 汎用モーダル (`.modal-overlay` + `.modal`)

| プロパティ | 値 |
|------------|-----|
| overlay | `rgba(0,0,0,0.45)`, z-index 200 |
| 本体 | 白背景, radius10, p36x40, min-w320, shadow |
| アニメーション | なし（即時表示） |

#### 警告モーダル (`.modal--warn`)
取下げ・戻る確認用。

| プロパティ | 値 |
|------------|-----|
| 幅 | `351px`（汎用） / `505px`（取下げ・やめる） |
| 背景 | `#FFF0F0`（汎用）/ `#FFF1EC`（取下げ系） |
| ボーダー | `2px solid #DF4C4C` / `#FFB499` |
| radius | `8px` |
| タイトル色 | `#DF4C4C`（汎用）/ `#FF7846`（取下げ系） |

#### 修正ファイルアップロード モーダル (`.detail-upload-modal`)

| プロパティ | 値 |
|------------|-----|
| z-index | `1000` |
| ダイアログ幅 | `1121px` (max `90vw`) |
| radius | `12px` |
| shadow | `0 8px 32px rgba(0,0,0,0.18)` |
| ヘッダー | ボーダー下線区切り |
| フッター | ボーダー上線区切り、ボタン中央配置 |

#### カレンダーモーダル (`.calendar-modal`)

| プロパティ | 値 |
|------------|-----|
| z-index | `200` |
| 幅 | `866px` (max `calc(100vw - 32px)`) |
| radius | `12px` |
| アニメーション | `calModalIn` (0.2s fadeIn + translateY) |
| 月ナビ | pill型（左半円 / 右半円ボタン）|
| グリッド | 7列グリッド, min行高 `72px` |
| 今日の日付 | 青丸 `#3a7bd5` 背景に白テキスト |

### 3.5 ドロップゾーン (Drop Zone)

ファイルアップロード用のインタラクティブエリア。

| 状態 | ボーダー | 背景 | その他 |
|------|----------|------|--------|
| デフォルト | `2px dashed #9C9C9C` | `#EFEFEF` | cursor: pointer |
| ドラッグオーバー | `solid #3a7bd5` | `#e8f0fe` | - |
| 成功 | `solid #2e7d32` | `#f1f8f1` | - |
| 解析中 | `solid #1565c0` | `#f0f4ff` | pointer-events:none, スピナー表示 |
| 非活性 | - | - | opacity:0.5, pointer-events:none |

### 3.6 ステータスバッジ (Status Badges)

#### 詳細画面用 (`.detail-status-badge`)
固定幅 `84px`, 高さ `22px`, font `14px`, radius `4px`。

| ステータス | クラス | 背景 | 文字色 |
|-----------|--------|------|--------|
| 未検閲 / 確認中 | `.badge--pending` / `.badge--requested` | `#EFEFF9` | `#6464C3` |
| 差戻し | `.badge--returned` | `#FFFEEF` | `#3C3C3C` (icon `#FF7846`) |
| 否認 | `.badge--disputed` | `#FFE4E4` | `#3C3C3C` (icon `#DF4C4C`) |
| 承認 | `.badge--approved` | `#CDF6EF` | `#159E85` |
| 取り下げ済 | `.badge--withdrawn` | `#CDF6EF` | `#159E85` |

#### 一覧画面用 (`.badge`)
`padding: 3px 12px`, radius `12px`, font `12px Bold`。

| ステータス | クラス | 背景 | 文字色 |
|-----------|--------|------|--------|
| 未対応 | `.badge--none` | `#B4B4B4` | `#fff` |
| 要再提出 | `.badge--resubmit` | `#FF7846` | `#fff` |
| 否認 | `.badge--denial` | `#DF4C4C` | `#fff` |

### 3.7 アコーディオン

#### 加盟店アコーディオン（確認画面: `.store-accordion`）

| プロパティ | 値 |
|------------|-----|
| ヘッダー背景 | `#F1F2F3`, hover: `#E5E6E7` |
| ヘッダーパディング | `14px 18px` |
| 開閉アイコン | `fa-chevron-down`, `#00A7B8`, 180°回転 |
| 本体背景 | `#F1F2F3` |

#### 詳細画面 店舗アコーディオン (`.dsl-accordion`)

| プロパティ | 値 |
|------------|-----|
| ヘッダー背景 | transparent, hover: `#F9FBFF` |
| パディング | `13px 16px` |
| 差戻し表示 | 左ボーダー `3px solid #f5a623`, 背景 `#fffdf8` |

#### 明細アコーディオン (`.detail-accordion`)

| プロパティ | 値 |
|------------|-----|
| ラベル色 | `#335B77`, font `16px` |
| ヘッダー背景 | `#F1F2F3`, hover: `#CBCBCB` |
| 本体背景 | `#FFF` |

### 3.8 テーブル

#### 請求履歴テーブル (`.billing-history-table`)

| プロパティ | 値 |
|------------|-----|
| 背景 | `#fff`, radius `8px`, shadow |
| thead 背景 | `#CCD6DD` |
| thead 文字 | `#335B77`, font `16px Regular` |
| tbody 行 hover | `#f5fafa` |
| td パディング | `12px 16px` |

#### 明細テーブル (`.detail-table` / `.dsl-lines-table`)

| プロパティ | `.detail-table` | `.dsl-lines-table` |
|------------|-----------------|---------------------|
| font-size | 13px | 13px |
| th 背景 | `#EAEBED` | `#EFEFEF` |
| th 文字色 | `#335B77` | `#666` |
| td 文字色 | `#335B77` | `#333` |
| 行 hover | `#F9FBFF` | `#F5F8FF` |

### 3.9 フォーム要素

#### 金額入力 (`.amount-input`)

| プロパティ | 値 |
|------------|-----|
| border | `1px solid #C9D4E8` |
| radius | `4px` |
| text-align | right |
| font | 14px SemiBold `#1a2b4a` |
| focus | border `#4A7FF5`, shadow `rgba(74,127,245,.15)` |
| 主要金額バリアント | font 20px Bold |

#### 備考入力 (`.remarks-input`)

| プロパティ | 値 |
|------------|-----|
| border | `1px solid #C9D4E8` |
| radius | `4px` |
| font | 13px |
| focus | border `#4A7FF5`, shadow |
| readonly | 背景 `#F5F5F5`, 文字 `#888` |

### 3.10 ローディングオーバーレイ (`.loading-overlay`)

| プロパティ | 値 |
|------------|-----|
| 配置 | fixed, inset:0 |
| 背景 | `rgba(255,255,255,0.85)` + `blur(2px)` |
| z-index | `9999` |
| スピナー | Font Awesome `fa-spinner fa-spin`, 48px |
| テキスト | 16px SemiBold `#374151` |

### 3.11 テキストリンク

| クラス | 色 | 用途 |
|--------|-----|------|
| `.link-template` | `#00A7B8` | テンプレートダウンロード（右寄せ） |
| `.btn-detail-link` | `#00A7B8` | 一覧テーブルの詳細リンク |

---

## 4. ページ固有コンポーネント

### 4.1 ヘッダー (`.site-header`)

| プロパティ | 値 |
|------------|-----|
| 高さ | `80px` |
| 背景 | `#1a2b4a` |
| 最小幅 | `1280px` |
| パディング | `12px 32px` |
| レイアウト | flex, space-between, center |

**左側**: ロゴリンク（`header-logo` 32px Bold + `header-produced` 18px Bold `#B9BEC3`）  
**右側**: カレンダーボタン + 卸売業者名

#### カレンダーボタン (`.btn-calendar-open`)
| プロパティ | 値 |
|------------|-----|
| 幅 | `251px`, 高さ `48px` |
| 背景 | `#FFF`, radius `64px` |
| shadow | `0 0 4px rgba(0,0,0,.12), 0 0 8px rgba(0,0,0,.12)` |
| font | 18px Regular `#3C3C3C` |
| アイコン | `fa-calendar`, `#003255` |

### 4.2 フッター (`.site-footer`)

| プロパティ | 値 |
|------------|-----|
| テキスト | 中央配置, 12px Regular `#999` |
| 背景 | `#F8F8F9`（ベースと同色） |
| パディング | `14px` |

### 4.3 ページタイトル (`.page-header`)

| プロパティ | 値 |
|------------|-----|
| レイアウト | flex, space-between, center |
| 下マージン | `20px` |
| タイトル | 28px Regular |

### 4.4 エラーページ (`.error-page`)

| プロパティ | 値 |
|------------|-----|
| カード最大幅 | `560px` |
| バナー背景 | `#fdecea`, ボーダー下 `#f5c6c6`, 文字 `#c62828` |
| 本体 font | 14px, line-height 1.8, 文字 `#333` |

---

## 5. アイコン

**Font Awesome 6.5.0** (CDN) を使用。

| 用途 | アイコン |
|------|----------|
| カレンダー | `fa-regular fa-calendar` |
| エラー通知 | `fa-solid fa-circle-exclamation` |
| スピナー | `fa-solid fa-spinner fa-spin` |
| アコーディオン開閉 | `fa-solid fa-chevron-down` |
| 削除 | `fa-solid fa-trash-can` |
| 戻る矢印 | `fa-solid fa-arrow-left` |
| 進む矢印 | `fa-solid fa-arrow-right` |
| 差戻し | `fa-solid fa-exclamation-triangle`（オレンジ） |
| 否認 | `fa-solid fa-times-circle`（赤） |

---

## 6. アニメーション / トランジション

| 対象 | 種類 | 値 |
|------|------|-----|
| ボタン hover | background | `0.15s` |
| アコーディオンアイコン | transform rotate | `0.2s` |
| ドロップゾーン | border-color, background | `0.2s` |
| カレンダーモーダル | fadeIn + translateY | `0.2s ease-out` |
| ドロップゾーンスピナー | rotate | `0.8s linear infinite` |

---

## 7. z-index 管理

| レイヤー | z-index | 対象 |
|----------|---------|------|
| ローディング | `9999` | `.loading-overlay` |
| 修正アップロードモーダル | `1000` | `.detail-upload-modal` |
| モーダル / カレンダー | `200` | `.modal-overlay`, `.calendar-modal-overlay` |
| Toast | `100` | `.toast` |
| ツールチップ | `9999` (fixed) | `.detail-meta-tooltip` |