console.log('App initialized');

// =============================================================================
// Router: ハッシュベースの簡易 SPA ルーター
// =============================================================================

/**
 * 登録済みページのマップ。
 * key   : URL ハッシュ（'#upload' など）
 * value : そのページのルート要素の id
 */
const ROUTES = {
  '#home':    'pageHome',
  '#upload':  'pageUpload',
  '#confirm': 'pageConfirm',
  '#detail':  'pageDetail',
};

/** デフォルトルート */
const DEFAULT_ROUTE = '#home';

/**
 * location.hash から { baseHash, params } を取り出す。
 * 例: '#detail?invoiceId=b001' → { baseHash: '#detail', params: URLSearchParams }
 * @returns {{ baseHash: string, params: URLSearchParams }}
 */
function parseHash() {
  const raw = location.hash || DEFAULT_ROUTE;
  const sepIdx = raw.indexOf('?');
  if (sepIdx === -1) {
    return { baseHash: raw, params: new URLSearchParams() };
  }
  return {
    baseHash: raw.slice(0, sepIdx),
    params:   new URLSearchParams(raw.slice(sepIdx + 1)),
  };
}

/**
 * 現在のハッシュに対応するページだけ表示し、他を非表示にする。
 */
function navigate() {
  const { baseHash, params } = parseHash();
  const targetId = ROUTES[baseHash] || ROUTES[DEFAULT_ROUTE];

  Object.values(ROUTES).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== targetId);
  });

  if (targetId === 'pageHome') {
    initHomePage();
  }

  if (targetId === 'pageConfirm') {
    renderConfirmPage();
  }

  if (targetId === 'pageDetail') {
    const invoiceId = params.get('invoiceId') || null;
    console.log('[router] 詳細画面: invoiceId =', invoiceId);
    // TODO: initDetailPage(invoiceId) を呼ぶ
  }

  console.log(`[router] navigated to ${baseHash} -> #${targetId}`);
}

// ハッシュ変化時・初回ロード時にルーティング実行
window.addEventListener('hashchange', navigate);
window.addEventListener('DOMContentLoaded', navigate);

// =============================================================================
// Home page: カレンダー状態
// =============================================================================

/** 現在表示中の年月（初期値は実行時の当月） */
const _today = new Date();
let calYear  = _today.getFullYear();
let calMonth = _today.getMonth(); // 0始まり

/** スケジュールデータのキャッシュ（日付文字列 → オブジェクト配列） */
let scheduleMap = {};

// =============================================================================
// Home page: 初期化
// =============================================================================

/**
 * ホーム画面表示時に GAS からデータを取得し、カレンダーと請求履歴を描画する。
 * 既に描画済みの場合は再描画しない（フラグ管理）。
 */
let homeInitialized = false;

function initHomePage() {
  if (homeInitialized) return;
  homeInitialized = true;

  // カレンダーナビゲーションボタンのイベント登録
  document.getElementById('calPrev').addEventListener('click', () => {
    calMonth -= 1;
    if (calMonth < 0) { calMonth = 11; calYear -= 1; }
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    calMonth += 1;
    if (calMonth > 11) { calMonth = 0; calYear += 1; }
    renderCalendar();
  });

  if (typeof google !== 'undefined' && google.script && google.script.run) {
    // スケジュールデータ取得
    google.script.run
      .withSuccessHandler(function(result) {
        buildScheduleMap(result && result.data ? result.data : []);
        renderCalendar();
      })
      .withFailureHandler(function(err) {
        console.error('[home] getMockScheduleData failed:', err);
        renderCalendar(); // データなしでもカレンダーは表示
      })
      .getMockScheduleData();

    // 請求履歴取得
    google.script.run
      .withSuccessHandler(function(result) {
        renderBillingHistory(result && result.data ? result.data : []);
      })
      .withFailureHandler(function(err) {
        console.error('[home] getMockBillingHistory failed:', err);
        renderBillingHistory([]); // 失敗時も空リストを描画しUIが空白にならないようにする
      })
      .getMockBillingHistory();
  } else {
    // ローカル確認用フォールバック
    // NOTE: 以下のデータは server.js の MOCK_SCHEDULE_ / MOCK_BILLING_BASE_ / MOCK_BILLING_ENTRIES_
    //       と同一形式を維持すること。BackOffice API 実装後は両方まとめて削除する。
    console.warn('[home] google.script.run が利用できません。モックデータを使用します。');
    const mockSchedule = [
      { date: '2026-05-13', title: '請求確定', type: 'billing' },
      { date: '2026-05-27', title: '口座振替', type: 'payment' },
    ];
    /** server.js MOCK_BILLING_BASE_ と同一 */
    const billingBase = {
      billingAmount: 99999999, subtotalExTax: 90000000, taxAmount: 9999999,
      breakdown: [
        { rate: 10, subtotalExTax: 49999999, taxAmount: 4999999 },
        { rate: 8,  subtotalExTax: 50000000, taxAmount: 4000000 },
      ],
      fee: 9999999, transferAmount: 990000000, status: '支払完了',
    };
    /** server.js MOCK_BILLING_ENTRIES_ と同一 */
    const mockBilling = [
      { id: 'b001', monthLabel: '4月' },
      { id: 'b002', monthLabel: '3月' },
      { id: 'b003', monthLabel: '2月' },
      { id: 'b004', monthLabel: '1月' },
    ].map(entry => Object.assign({}, billingBase, entry));
    buildScheduleMap(mockSchedule);
    renderCalendar();
    renderBillingHistory(mockBilling);
  }
}

// =============================================================================
// Home page: スケジュールマップ構築
// =============================================================================

/**
 * 配列 → { '2026-05-13': [{...}], ... } の形に変換してキャッシュ
 * @param {Array<{date:string, title:string, type:string}>} items
 */
function buildScheduleMap(items) {
  scheduleMap = {};
  (items || []).forEach(item => {
    if (!scheduleMap[item.date]) scheduleMap[item.date] = [];
    scheduleMap[item.date].push(item);
  });
}

// =============================================================================
// Home page: カレンダー描画
// =============================================================================

function renderCalendar() {
  const label = document.getElementById('calMonthLabel');
  const grid  = document.getElementById('calGrid');
  if (!label || !grid) return;

  label.innerHTML = `<span class="cal-label__year">${calYear}年</span><span class="cal-label__month">${calMonth + 1}月</span>`;
  grid.innerHTML  = '';

  // 月の初日の曜日（0=日, 6=土）
  const firstDay  = new Date(calYear, calMonth, 1).getDay();
  // 月の末日
  const lastDate  = new Date(calYear, calMonth + 1, 0).getDate();
  // 今日
  const today     = new Date();
  const isThisMonth = today.getFullYear() === calYear && today.getMonth() === calMonth;

  // 空白セル（月初前）
  for (let i = 0; i < firstDay; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell cal-cell--empty';
    grid.appendChild(blank);
  }

  // 日付セル
  for (let d = 1; d <= lastDate; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell';

    const mm   = String(calMonth + 1).padStart(2, '0');
    const dd   = String(d).padStart(2, '0');
    const key  = `${calYear}-${mm}-${dd}`;

    if (isThisMonth && d === today.getDate()) {
      cell.classList.add('cal-cell--today');
    }

    // 日付番号
    const num = document.createElement('span');
    num.className   = 'cal-cell__num';
    num.textContent = String(d);
    cell.appendChild(num);

    // スケジュールバッジ
    const events = scheduleMap[key] || [];
    events.forEach(ev => {
      const badge = document.createElement('div');
      badge.className = `cal-badge cal-badge--${ev.type}`;
      badge.textContent = ev.title;
      cell.appendChild(badge);
    });

    if (events.length > 0) {
      cell.classList.add('cal-cell--has-event');
    }

    grid.appendChild(cell);
  }
}

// =============================================================================
// Home page: 請求履歴描画
// =============================================================================

/**
 * 請求履歴リストを描画する
 * @param {Array<{
 *   id: string,
 *   monthLabel: string,
 *   billingAmount: number,
 *   subtotalExTax: number,
 *   taxAmount: number,
 *   breakdown: Array<{rate: number, subtotalExTax: number, taxAmount: number}>,
 *   fee: number,
 *   transferAmount: number,
 *   status: string
 * }>} items
 */
function renderBillingHistory(items) {
  const list = document.getElementById('billingHistoryList');
  if (!list) return;
  list.innerHTML = '';

  if (!items || items.length === 0) {
    list.innerHTML = '<p class="billing-empty">請求履歴がありません。</p>';
    return;
  }

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'billing-card';

    const fmt = n => Number(n).toLocaleString('ja-JP');

    // 内訳：グリッド表形式（内訳 | 小計ラベル | 税額ラベル → 10% | 値 | 値 → 8% | 値 | 値）
    const rateItems = (item.breakdown || []);
    const breakdownDataRows = rateItems.map(b => `
      <div class="bc-breakdown__cell bc-breakdown__rate">${escapeHtml(String(b.rate))}%</div>
      <div class="bc-breakdown__cell bc-breakdown__col-val">${fmt(b.subtotalExTax)}円</div>
      <div class="bc-breakdown__cell bc-breakdown__col-val">${fmt(b.taxAmount)}円</div>
    `).join('');

    card.innerHTML = `
      <div class="bc-month">${escapeHtml(item.monthLabel)}</div>

      <div class="bc-billing">
        <div class="bc-billing__label">請求金額</div>
        <div class="bc-billing__amount">${fmt(item.billingAmount)}円</div>
        <div class="bc-billing__sub">小計（税抜）<span>${fmt(item.subtotalExTax)}円</span></div>
        <div class="bc-billing__sub">税額<span>${fmt(item.taxAmount)}円</span></div>
      </div>

      <div class="bc-divider"></div>

      <div class="bc-breakdown">
        <div class="bc-breakdown__grid">
          <div class="bc-breakdown__cell bc-breakdown__title">内訳</div>
          <div class="bc-breakdown__cell bc-breakdown__col-label">小計（税抜）</div>
          <div class="bc-breakdown__cell bc-breakdown__col-label">税額</div>
          ${breakdownDataRows}
        </div>
      </div>

      <div class="bc-divider"></div>

      <div class="bc-fee">
        <div class="bc-fee__row">手数料<span>${fmt(item.fee)}円</span></div>
        <div class="bc-fee__row">振込金額<span>${fmt(item.transferAmount)}円</span></div>
      </div>

      <button type="button" class="bc-detail-link" data-id="${escapeHtml(item.id)}">詳細を見る &gt;</button>
    `;

    // 詳細リンク: invoiceId をハッシュクエリに含めて #detail へ遷移
    card.querySelector('.bc-detail-link').addEventListener('click', function() {
      location.hash = '#detail?invoiceId=' + encodeURIComponent(this.dataset.id);
    });

    list.appendChild(card);
  });
}

/**
 * XSS 対策: HTML 特殊文字をエスケープする
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}




// =============================================================================
// DOM references
// =============================================================================
const dropZone       = document.getElementById('dropZone');
const btnSelectFile  = document.getElementById('btnSelectFile');
const fileInput      = document.getElementById('fileInput');
const btnToConfirm   = document.getElementById('btnToConfirm');
const btnCancel      = document.getElementById('btnCancel');
const btnFinalSubmit = document.getElementById('btnFinalSubmit');
const errorCard      = document.getElementById('errorCard');
const alertList      = document.getElementById('alertList');
const toast          = document.getElementById('toast');
const toastClose     = document.getElementById('toastClose');

// =============================================================================
// State: バックエンド送信用データ保持
// =============================================================================

/** 読み込んだCSVの生テキスト（sendInvoiceData に渡す） */
let rawCsv = null;

/**
 * パース済みデータ行の配列。各要素はカラム名をキーとしたオブジェクト。
 * @type {Array<{storeCode:string, date:string, item:string, qty:number,
 *              unitPrice:number, taxRate:number, amountExTax:number,
 *              tax:number, note:string}>}
 */
let parsedData = null;

// sessionStorage からリロード時に復元（GAS セッションタイムアウト対策）
try {
  const _saved = sessionStorage.getItem('shiire_parsedData');
  const _raw   = sessionStorage.getItem('shiire_rawCsv');
  if (_saved) parsedData = JSON.parse(_saved);
  if (_raw)   rawCsv    = _raw;
} catch (e) {
  console.warn('[state] sessionStorage の復元に失敗しました:', e);
}

// =============================================================================
// Toast helpers
// =============================================================================

/** @param {string} message @param {'error'|'success'} [type='error'] */
function showToast(message, type = 'error') {
  document.getElementById('toastMessage').textContent = message;
  toast.classList.remove('hidden', 'toast--error', 'toast--success');
  toast.classList.add(`toast--${type}`);
}

function hideToast() {
  toast.classList.add('hidden');
}

toastClose.addEventListener('click', hideToast);

// =============================================================================
// Drop zone helpers
// =============================================================================

/** 初期状態の dropZone 内 HTML（リセット時に復元する） */
const DROP_ZONE_DEFAULT_HTML = dropZone.innerHTML;

/** dropZone を初期状態に戻す */
function resetDropZone() {
  dropZone.innerHTML = DROP_ZONE_DEFAULT_HTML;
  dropZone.classList.remove('is-success');
  // innerHTML 差し替え後に DOM 参照とイベントを再登録
  const newBtn   = dropZone.querySelector('#btnSelectFile');
  const newInput = dropZone.querySelector('#fileInput');
  newBtn.addEventListener('click', () => newInput.click());
  newInput.addEventListener('change', function () {
    if (this.files[0]) handleFile(this.files[0]);
    this.value = '';
  });
}

/**
 * dropZone を成功表示に切り替える
 * @param {string} fileName
 */
function setDropZoneSuccess(fileName) {
  dropZone.innerHTML = `
    <i class="fa-regular fa-circle-check drop-zone__icon drop-zone__icon--success"></i>
    <p class="drop-zone__text drop-zone__text--success">
      📄 <strong id="dropZoneFileName"></strong> を読み込みました
    </p>
    <button class="btn btn-select-file" id="btnSelectFile">
      <i class="fa-regular fa-folder-open"></i> 別のファイルを選択
    </button>
    <input type="file" id="fileInput" accept=".csv" hidden />
  `;
  // XSS対策: ファイル名は textContent で挿入
  dropZone.querySelector('#dropZoneFileName').textContent = fileName;
  dropZone.classList.add('is-success');
  // 再バインド
  const newBtn   = dropZone.querySelector('#btnSelectFile');
  const newInput = dropZone.querySelector('#fileInput');
  newBtn.addEventListener('click', () => newInput.click());
  newInput.addEventListener('change', function () {
    if (this.files[0]) handleFile(this.files[0]);
    this.value = '';
  });
}

// =============================================================================
// Drag & Drop
// =============================================================================

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

['dragleave', 'dragend'].forEach(ev =>
  dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over'))
);

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// =============================================================================
// Click to select file
// =============================================================================

btnSelectFile.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
  // 同じファイルを再選択できるようリセット
  fileInput.value = '';
});

// =============================================================================
// File handler
// =============================================================================

/** @param {File} file */
function handleFile(file) {
  // ── Step 2: ファイル形式チェック ──────────────────────────────────────────
  if (!file.name.toLowerCase().endsWith('.csv')) {
    showToast('CSVファイルを選択してください');
    resetDropZone();
    return;
  }

  hideToast();

  // ── Step 3: CSVを読み込んでパース＆バリデーション ────────────────────────
  const reader = new FileReader();

  reader.onload = e => {
    const text = e.target.result;
    const { errors, rows } = validateCsv(text);

    if (errors.length === 0) {
      // 成功: グローバル変数に保持
      rawCsv     = text;
      parsedData = rows;
      // リロード対策: sessionStorage に保存
      try {
        sessionStorage.setItem('shiire_parsedData', JSON.stringify(rows));
        sessionStorage.setItem('shiire_rawCsv', text);
      } catch (e) {
        console.warn('[state] sessionStorage への保存に失敗しました:', e);
      }
    } else {
      // エラー: 保持データをクリア
      rawCsv     = null;
      parsedData = null;
      sessionStorage.removeItem('shiire_parsedData');
      sessionStorage.removeItem('shiire_rawCsv');
    }

    renderErrors(errors, file.name);
  };

  reader.onerror = () => {
    showToast('ファイルの読み込みに失敗しました');
    resetDropZone();
  };

  reader.readAsText(file, 'UTF-8');
}

// =============================================================================
// CSV parse & validate
// =============================================================================

/**
 * ダブルクォーテーション対応の1行パーサ。
 * 各フィールドを囲むダブルクォーテーションを除去して返す。
 *
 * @param {string} line - CSVの1行文字列
 * @returns {string[]} フィールド値の配列
 */
function parseCsvLine(line) {
  const result = [];
  // RFC 4180 に準拠した簡易実装:
  // - "..." → ... (クォーテーション除去)
  // - "" 内のカンマは区切り文字扱いしない
  const re = /("(?:[^"]|"")*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    // re がマッチするたびに1フィールド + 後続カンマ分を進める
    let val = m[1];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/""/g, '"');
    }
    result.push(val.trim());
    // カンマを読み飛ばす（末尾フィールドの場合は終了）
    if (re.lastIndex < line.length && line[re.lastIndex] === ',') {
      re.lastIndex += 1;
    } else if (re.lastIndex < line.length) {
      break; // 予期しない文字 → ループ抜け
    } else {
      break;
    }
  }
  return result;
}

/**
 * CSVテキストをパースし、バリデーションエラーメッセージの配列を返す。
 * エラーがなければ空配列を返す。
 *
 * カラム構成（1行目はヘッダー、2行目以降がデータ）:
 *   [0] 加盟店コード    (必須)
 *   [1] 日付            (必須, YYYY-MM-DD)
 *   [2] 品目            (必須)
 *   [3] 数量            (必須, 数値)
 *   [4] 単価            (必須, 数値)
 *   [5] 税率区分(%)     (必須, "8" or "10")
 *   [6] 請求金額（税抜）(必須, 数値)
 *   [7] 消費税          (必須, 数値)
 *   [8] 備考            (任意)
 *
 * @param {string} csvText
 * @returns {{ errors: string[], rows: object[] }}
 */
function validateCsv(csvText) {
  const errors = [];
  const rows   = []; // パース済み行データ
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const EXPECTED_COLS = 9;

  // 改行コードを統一してから分割、末尾の空行を除去
  const lines = csvText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(line => line.trim() !== '');

  // ── ヘッダー行チェック ──────────────────────────────────────────────────
  const EXPECTED_HEADERS = [
    '加盟店コード', '日付', '品目', '数量', '単価',
    '税率区分(%)', '請求金額（税抜）', '消費税', '備考',
  ];
  const headerCols = parseCsvLine(lines[0]);
  if (headerCols.length !== EXPECTED_COLS) {
    errors.push(`ヘッダー行のカラム数が正しくありません（${headerCols.length}列 / 期待値: ${EXPECTED_COLS}列）`);
    return { errors, rows };
  }
  const headerErrors = EXPECTED_HEADERS
    .map((name, idx) => headerCols[idx] !== name
      ? `ヘッダー行 ${idx + 1}列目: "${name}" が期待されますが "${headerCols[idx]}" になっています`
      : null
    )
    .filter(Boolean);
  if (headerErrors.length > 0) {
    errors.push(...headerErrors);
    return { errors, rows };
  }

  // ヘッダー含めて1行しかない（データなし）場合
  if (lines.length <= 1) {
    errors.push('CSVにデータ行が1件もありません');
    return { errors, rows };
  }

  // 2行目（index=1）以降がデータ行
  // rowNum はヘッダーを1行目とした実際の行番号 (index + 1)
  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1; // ヘッダー = 1行目なのでデータは2行目〜
    const cols = parseCsvLine(lines[i]);
    const rowErrors = [];

    // ── カラム数チェック ───────────────────────────────────────────────────
    if (cols.length !== EXPECTED_COLS) {
      errors.push(`${rowNum}行目: カラム数が正しくありません（${cols.length}列 / 期待値: ${EXPECTED_COLS}列）`);
      continue; // 列数が違う場合は以降のチェックをスキップ
    }

    // ── [0] 加盟店コード（必須）────────────────────────────────────────────
    if (cols[0] === '') {
      rowErrors.push(`${rowNum}行目: 加盟店コードを入力してください`);
    }

    // ── [1] 日付（必須, YYYY-MM-DD）───────────────────────────────────────
    if (cols[1] === '') {
      rowErrors.push(`${rowNum}行目: 日付を入力してください`);
    } else if (!DATE_RE.test(cols[1])) {
      rowErrors.push(`${rowNum}行目: 日付はYYYY-MM-DD形式で入力してください`);
    }

    // ── [2] 品目（必須）────────────────────────────────────────────────────
    if (cols[2] === '') {
      rowErrors.push(`${rowNum}行目: 品目を入力してください`);
    }

    // ── [3] 数量（必須, 数値）──────────────────────────────────────────────
    if (cols[3] === '' || isNaN(Number(cols[3]))) {
      rowErrors.push(`${rowNum}行目: 数量が数値ではありません`);
    }

    // ── [4] 単価（必須, 数値）──────────────────────────────────────────────
    if (cols[4] === '' || isNaN(Number(cols[4]))) {
      rowErrors.push(`${rowNum}行目: 単価が数値ではありません`);
    }

    // ── [5] 税率区分（必須, "8" or "10"）──────────────────────────────────
    if (cols[5] !== '8' && cols[5] !== '10') {
      rowErrors.push(`${rowNum}行目: 税率区分は8か10を入力してください`);
    }

    // ── [6] 請求金額（税抜）（必須, 数値）─────────────────────────────────
    if (cols[6] === '' || isNaN(Number(cols[6]))) {
      rowErrors.push(`${rowNum}行目: 請求金額（税抜）が数値ではありません`);
    }

    // ── [7] 消費税（必須, 数値）────────────────────────────────────────────
    if (cols[7] === '' || isNaN(Number(cols[7]))) {
      rowErrors.push(`${rowNum}行目: 消費税が数値ではありません`);
    }

    // [8] 備考は任意のためチェックなし

    if (rowErrors.length === 0) {
      // エラーなし → パース済みオブジェクトとして保存
      rows.push({
        storeCode:   cols[0],
        date:        cols[1],
        item:        cols[2],
        qty:         Number(cols[3]),
        unitPrice:   Number(cols[4]),
        taxRate:     Number(cols[5]),
        amountExTax: Number(cols[6]),
        tax:         Number(cols[7]),
        note:        cols[8],
      });
    } else {
      errors.push(...rowErrors);
    }
  }

  return { errors, rows };
}

// =============================================================================
// Render errors to UI
// =============================================================================

/**
 * @param {string[]} errors
 * @param {string}   [fileName] - 成功時に dropZone に表示するファイル名
 */
function renderErrors(errors, fileName) {
  // リストをいったん空にする
  alertList.innerHTML = '';

  if (errors.length > 0) {
    // エラーがある → dropZone を初期状態に戻す → リスト生成 → errorCard 表示 → 送信ボタン disabled
    resetDropZone();
    errors.forEach(msg => {
      const li = document.createElement('li');
      li.className = 'alert-item alert-item--error';
      li.innerHTML = '<i class="fa-solid fa-circle alert-icon"></i>' + msg;
      alertList.appendChild(li);
    });
    errorCard.classList.remove('hidden');
    btnToConfirm.disabled = true;
  } else {
    // エラーなし → dropZone を成功表示に → errorCard 非表示 → 送信ボタン活性
    setDropZoneSuccess(fileName || '');
    errorCard.classList.add('hidden');
    btnToConfirm.disabled = false;
  }
}

// =============================================================================
// Submit: GAS バックエンドへの送信処理
// =============================================================================

/** 確認ページ送信ボタンのデフォルトラベル（リセット時に使用） */
const SUBMIT_DEFAULT_HTML = '登録内容を送信する <i class="fa-solid fa-chevron-right"></i>';

/** 送信中 UI に切り替える */
function setSubmitLoading() {
  btnFinalSubmit.disabled = true;
  btnFinalSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 送信中...';
}

/** 送信ボタンを通常状態に戻す */
function resetSubmitButton() {
  btnFinalSubmit.disabled = false;
  btnFinalSubmit.innerHTML = SUBMIT_DEFAULT_HTML;
}

/**
 * 画面全体を初期状態にリセットする（送信成功後に呼ぶ）
 */
function resetPage() {
  rawCsv     = null;
  parsedData = null;
  sessionStorage.removeItem('shiire_parsedData');
  sessionStorage.removeItem('shiire_rawCsv');
  resetDropZone();
  alertList.innerHTML = '';
  errorCard.classList.add('hidden');
  btnToConfirm.disabled = true;
  btnToConfirm.innerHTML = '確認画面へ進む <i class="fa-solid fa-chevron-right"></i>';
  resetSubmitButton();
  hideToast();
}

// アップロードページ: 確認画面へ進むボタン
btnToConfirm.addEventListener('click', () => {
  if (!parsedData || !rawCsv) {
    showToast('送信できるデータがありません。CSVを再度選択してください。', 'error');
    return;
  }
  location.hash = '#confirm';
});

// アップロードページ: キャンセルボタン → アップロード前の初期状態に戻す
btnCancel.addEventListener('click', () => {
  resetPage();
});

// 確認ページ: キャンセルボタン → モーダルを表示
document.getElementById('btnConfirmCancel').addEventListener('click', () => {
  document.getElementById('cancelModal').classList.remove('hidden');
});

// モーダル: キャンセル（閉じるだけ）
document.getElementById('cancelModalClose').addEventListener('click', () => {
  document.getElementById('cancelModal').classList.add('hidden');
});

// モーダル: OK → データをリセットしアップロード画面へ
document.getElementById('cancelModalOk').addEventListener('click', () => {
  document.getElementById('cancelModal').classList.add('hidden');
  resetPage();
  location.hash = '#upload';
});

// モーダル: オーバーレイクリックで閉じる
document.getElementById('cancelModal').addEventListener('click', function (e) {
  if (e.target === this) this.classList.add('hidden');
});

// 確認ページ: 登録内容を送信するボタン
btnFinalSubmit.addEventListener('click', () => {
  // 送信可能なデータが揃っているか念のため確認
  if (!parsedData || !rawCsv) {
    showToast('送信できるデータがありません。アップロードページからやり直してください。', 'error');
    location.hash = '#upload';
    return;
  }

  // ── 送信開始: UI をローディング状態に ─────────────────────────────────────
  setSubmitLoading();
  hideToast();

  // ── GAS バックエンドへ送信 ────────────────────────────────────────────────
  // google.script.run は GAS Webアプリ環境でのみ有効。
  // ローカル Live Server で動作確認する場合は下部の「ローカル確認用フォールバック」が使われる。
  if (typeof google !== 'undefined' && google.script && google.script.run) {
    google.script.run
      .withSuccessHandler(onSubmitSuccess)
      .withFailureHandler(onSubmitFailure)
      .sendInvoiceData(parsedData, rawCsv);
  } else {
    // ── ローカル確認用フォールバック（GAS 環境外）────────────────────────
    console.warn('[submit] google.script.run が利用できません。モック送信を実行します。');
    console.log('[submit] jsonData:', parsedData);
    console.log('[submit] csvContent (先頭200文字):', rawCsv.slice(0, 200));
    setTimeout(() => onSubmitSuccess({ status: 'success', data: '(mock)' }), 800);
  }
});

/**
 * 送信成功ハンドラ
 * @param {{ status: string, data: * }} result - server.js の success_() が返すオブジェクト
 *   エラー時は error_() が返したオブジェクトが SuccessHandler に流れる場合がある
 */
function onSubmitSuccess(result) {
  console.log('[submit] success:', result);
  if (result && result.status === 'error') {
    // GAS 側が _error() を返した場合（SuccessHandler に流れるがエラー扱い）
    showToast('送信に失敗しました: ' + (result.message || '不明なエラー'), 'error');
    resetSubmitButton();
    return;
  }
  resetPage();
  location.hash = '#home';
  showToast('送信が完了しました', 'success');
}

/**
 * 送信失敗ハンドラ
 * @param {Error} error
 */
function onSubmitFailure(error) {
  console.error('[submit] failure:', error);
  showToast('送信に失敗しました: ' + (error.message || error), 'error');
  resetSubmitButton(); // 再送信できるようにボタンを戻す
}

// 確認ページ: チェックボックスで送信ボタンの活性/非活性を切り替える
document.getElementById('checkConfirm').addEventListener('change', function () {
  btnFinalSubmit.disabled = !this.checked;
});

// =============================================================================
// Confirm page: render
// =============================================================================

/**
 * 確認画面を parsedData を元に描画する。
 * navigate() が '#confirm' に切り替えるたびに呼ばれる。
 */
function renderConfirmPage() {
  // データがなければアップロード画面へ戻す
  if (!parsedData || parsedData.length === 0) {
    location.hash = '#upload';
    return;
  }

  // チェックボックス・送信ボタンをリセット
  const checkConfirm = document.getElementById('checkConfirm');
  if (checkConfirm) checkConfirm.checked = false;
  btnFinalSubmit.disabled = true;

  // ── サマリー計算 ────────────────────────────────────────────────────────
  const storeCodes       = new Set(parsedData.map(r => r.storeCode));
  const totalAmountExTax = parsedData.reduce((s, r) => s + r.amountExTax, 0);
  const totalTax         = parsedData.reduce((s, r) => s + r.tax, 0);
  const totalAmountInTax = totalAmountExTax + totalTax;

  // 税率別内訳
  const rows10 = parsedData.filter(r => r.taxRate === 10);
  const rows8  = parsedData.filter(r => r.taxRate === 8);
  const exTax10 = rows10.reduce((s, r) => s + r.amountExTax, 0);
  const tax10   = rows10.reduce((s, r) => s + r.tax, 0);
  const exTax8  = rows8.reduce((s, r) => s + r.amountExTax, 0);
  const tax8    = rows8.reduce((s, r) => s + r.tax, 0);

  /** @param {number} n */
  const fmt = n => n.toLocaleString('ja-JP') + '円';

  document.getElementById('summaryAmountInTax').textContent = fmt(totalAmountInTax);
  document.getElementById('summaryAmountExTax').textContent = fmt(totalAmountExTax);
  document.getElementById('summaryTax').textContent         = fmt(totalTax);

  const fee      = Math.floor(totalAmountInTax * 0.05);
  const transfer = totalAmountInTax - fee;
  document.getElementById('summaryFee').textContent      = fmt(fee);
  document.getElementById('summaryTransfer').textContent = fmt(transfer);

  document.getElementById('summaryExTax10').textContent     = fmt(exTax10);
  document.getElementById('summaryTax10').textContent       = fmt(tax10);
  document.getElementById('summaryExTax8').textContent      = fmt(exTax8);
  document.getElementById('summaryTax8').textContent        = fmt(tax8);

  // ── 加盟店ごとにグルーピング ─────────────────────────────────────────────
  /** @type {Map<string, typeof parsedData>} */
  const groups = new Map();
  parsedData.forEach(row => {
    if (!groups.has(row.storeCode)) groups.set(row.storeCode, []);
    groups.get(row.storeCode).push(row);
  });

  // ── 加盟店別リストを描画 ──────────────────────────────────────────────────
  const list = document.getElementById('confirmStoreList');
  list.innerHTML = '';

  // 列ヘッダー行
  const colHeader = document.createElement('div');
  colHeader.className = 'store-list-header';
  colHeader.innerHTML =
    `<span class="slh-col slh-col--name">加盟店名</span>` +
    `<span class="slh-col slh-col--amount">請求金額</span>` +
    `<span class="slh-col slh-col--extax">小計（税抜）</span>` +
    `<span class="slh-col slh-col--tax">消費税</span>` +
    `<span class="slh-col slh-col--tax8">消費税内訳（8%）</span>` +
    `<span class="slh-col slh-col--tax10">消費税内訳（10%）</span>` +
    `<span class="slh-col slh-col--toggle"></span>`;
  list.appendChild(colHeader);

  groups.forEach((rows, storeCode) => {
    const storeAmountExTax = rows.reduce((s, r) => s + r.amountExTax, 0);
    const storeTax         = rows.reduce((s, r) => s + r.tax, 0);
    const storeTotal       = storeAmountExTax + storeTax;
    const storeTax8        = rows.filter(r => r.taxRate === 8).reduce((s, r) => s + r.tax, 0);
    const storeTax10       = rows.filter(r => r.taxRate === 10).reduce((s, r) => s + r.tax, 0);

    // アコーディオンカード
    const card = document.createElement('div');
    card.className = 'store-accordion';

    // ヘッダー行
    const header = document.createElement('div');
    header.className = 'store-accordion__header';
    header.innerHTML =
      `<span class="slh-col slh-col--name store-accordion__code">${escapeHtml(storeCode)}</span>` +
      `<span class="slh-col slh-col--amount">${fmt(storeTotal)}</span>` +
      `<span class="slh-col slh-col--extax">${fmt(storeAmountExTax)}</span>` +
      `<span class="slh-col slh-col--tax">${fmt(storeTax)}</span>` +
      `<span class="slh-col slh-col--tax8"><input type="text" class="store-tax-input" value="${storeTax8.toLocaleString('ja-JP')}" readonly /><span class="store-tax-unit">円</span></span>` +
      `<span class="slh-col slh-col--tax10"><input type="text" class="store-tax-input" value="${storeTax10.toLocaleString('ja-JP')}" readonly /><span class="store-tax-unit">円</span></span>` +
      `<span class="slh-col slh-col--toggle"><i class="fa-solid fa-chevron-down store-accordion__icon"></i></span>`;

    // ボディ（明細カード一覧）
    const body = document.createElement('div');
    body.className = 'store-accordion__body';

    rows.forEach(row => {
      const item = document.createElement('div');
      item.className = 'detail-row';

      const fields = [
        { label: '取引日',   value: escapeHtml(row.date.replace(/-/g, '/')) },
        { label: '概要',     value: escapeHtml(row.item) },
        { label: '数量',     value: row.qty.toLocaleString('ja-JP') },
        { label: '単価',     value: row.unitPrice.toLocaleString('ja-JP') + '円' },
        { label: '明細金額', value: row.amountExTax.toLocaleString('ja-JP') + '円' },
        { label: '税率',     value: row.taxRate + '%' },
        { label: '消費税',   value: row.tax.toLocaleString('ja-JP') + '円' },
      ];

      const mainRow = document.createElement('div');
      mainRow.className = 'detail-row__main';
      mainRow.innerHTML = fields.map(f =>
        `<span class="detail-row__field">`+
          `<span class="detail-row__label">${f.label}</span>`+
          `<span class="detail-row__sep">|</span>`+
          `<span class="detail-row__value">${f.value}</span>`+
        `</span>`
      ).join('');
      item.appendChild(mainRow);

      const noteRow = document.createElement('div');
      noteRow.className = 'detail-row__note';
      noteRow.innerHTML = `<span class="detail-row__note-label">備考：</span>${row.note ? escapeHtml(row.note) : '<span class="detail-row__note-empty">なし</span>'}`;
      item.appendChild(noteRow);

      body.appendChild(item);
    });
    card.appendChild(header);
    card.appendChild(body);
    list.appendChild(card);

    // アコーディオン開閉トグル
    header.addEventListener('click', () => card.classList.toggle('is-open'));
  });
}

// =============================================================================
// CSV テンプレートダウンロード
// =============================================================================

/** BOM 付き UTF-8 CSV テンプレートをダウンロードする */
function downloadCsvTemplate() {
  const HEADERS = [
    '加盟店コード',
    '日付',
    '品目',
    '数量',
    '単価',
    '税率区分(%)',
    '請求金額（税抜）',
    '消費税',
    '備考',
  ];
  const csvContent = HEADERS.map(h => `"${h}"`).join(',') + '\r\n';

  // BOM (0xEF 0xBB 0xBF) を先頭に付与して UTF-8 BOM 付きにする
  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const a    = document.createElement('a');
  a.href     = url;
  a.download = '請求CSVテンプレート.csv';
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('btnTemplateDlHeader').addEventListener('click', downloadCsvTemplate);
document.getElementById('btnTemplateDlPage').addEventListener('click', e => {
  e.preventDefault();
  downloadCsvTemplate();
});