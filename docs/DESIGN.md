# DESIGN.md - フロントエンド設計定義書

## 1. デザインコンセプト & 共通仕様

本デザインは、視認性と操作性を重視したクリーンなUIを提供します。
コンポーネントはPCおよびスマートフォン（SP）の両デバイスに最適化されるよう設計されています。

### 1.1 レイアウト（画面幅定義）
Figmaの定義に基づき、以下のブレークポイントとコンテンツ幅を適用します。

* **作業用フレームサイズ**: `1920px`
* **確認画面用ブレークポイント**: `1440px` 以下
* **標準画面サイズ**: `1280px × 728px`
* **最大コンテンツサイズ**: `1248px`
* **最小コンテンツサイズ**: `1024px`

---

## 2. スタイルガイド (Style Guide)

### 2.1 タイポグラフィ (Typography)
* **ベースフォント**: `Noto Sans JP`

**【PC / SP 共通】**
* 補足テキスト: `12px Regular`
* エラーテキスト: `12px Bold`
* サブテキスト: `14px Regular`
* 標準テキスト: `16px Regular`
* セクションタイトル: `18px Bold`
* コンテンツタイトル: `24px Regular`
* 画面タイトル: `28px Regular`
* 強調する金額: `32px Regular`

### 2.2 カラーパレット (Color Palette)

#### Text (テキストカラー)
* `black--main`: `#3C3C3C` (メインテキスト)
* `darkgray--sub`: `#9C9C9C` (サブテキスト)
* `gray--disabled`: `#D4D4D4` (非活性テキスト)
* `gray--placeholdar`: `#C4C4C4` (プレースホルダー)
* `turquoise--accent/textlink`: `#00A7B8` (アクセント/リンク)
* `red--negative`: `#DF4C4C` (エラー/ネガティブ)

#### Background (背景色)
* `light-gray--bese`: `#F8F8F9` (ベース背景)
* `gray--note`: `#F1F2F3` (ノート背景)
* `gray--contents/select-button--off`: `#EAEBED` (コンテンツ背景/非選択ボタン)
* `dark-gray`: `#D7D7D7`
* `dark-gray--disabled`: `#D4D4D4`
* `dark-blue--main-button`: `#003255` (メインボタン)
* `turquoise--sub-button`: `#00A7B8` (サブボタン)
* `light-turquoise`: `#42A9FF`
* `red--negative`: `#DF4C4C`
* `light-yellow`: `#FFFEEF`
* `black--modal`: `#000000` (opacity 50%)
* `black--batch`: `#000000` (opacity 75%)

#### Line (罫線)
* `gray`: `#D7D7D7`

#### General (汎用カラー・ステータス等)
* `white`: `#FFFFFF`
* `turquoise`: `#00BFD3`
* `green--done/ok`: `#159E85` (完了/OK状態)
* `light-green--done/ok`: `#EFFACFA` (完了/OK状態の薄い背景)
* `red--error`: `#DF4C4C` (エラー状態)
* `light-red--error`: `#FFFOFO` (エラー状態の薄い背景)
* `orange`: `#FF7846`
* `light-orange`: `#FFF1EC`
* `violet`: `#64646C3`
* `light-violet`: `#EFEFF9`
* `dark-blue`: `#003255`
* `light-blue`: `#E5EAEE`

---

## 3. UIコンポーネント定義

### 3.1 ボタン (Buttons)

すべてのボタンは角丸（pill型）をベースとしています。

* **メインボタン**:
  * 活性: 背景 `dark-blue--main-button` (#003255) / 文字色 `white`
  * 非活性: 背景 `gray--disabled` (#D4D4D4) / 文字色 `white`
* **サブボタン**:
  * 活性: 背景 `turquoise--sub-button` (#00A7B8) / 文字色 `white`
  * 枠線のみパターンあり（文字・枠線色: `#00A7B8`）
* **ネガティブボタン**:
  * 活性: 背景 `red--negative` (#DF4C4C) / 文字色 `white`
  * 非活性状態あり
* **サブネガティブボタン**:
  * 枠線のみパターン（文字・枠線色: `#DF4C4C`）

### 3.2 アイコン・リンク
* **テキストリンク**: `#00A7B8` を使用。
* **アイコン付きアクション**: 「お知らせ一覧」「ID・パスワードをコピーする」「アカウントを削除」など、アイコンとテキスト（主にアクセントカラーまたはネガティブカラー）を組み合わせたアクション要素が存在。

### 3.3 リスト・パネル
* **店舗選択/表示パネル**: 白背景、右矢印アイコン付き。ステータスバッジ（「表示中」など）を内包するパターンあり。
* **アコーディオン/ドロップダウン**: 「支払い通知書」「日別売上一覧」などの折りたたみUIが存在。

### 3.4 グラフカラー (Chart Colors)
用途に応じたグラデーション・パレットが定義されています。
* **クレジットカード**: ターコイズ/ティール系のグラデーション
* **QRコード**: パープル系のグラデーション
* **電子マネー**: ネイビー/ブルー系のグラデーション