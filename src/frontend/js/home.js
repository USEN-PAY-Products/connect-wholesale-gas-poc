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
