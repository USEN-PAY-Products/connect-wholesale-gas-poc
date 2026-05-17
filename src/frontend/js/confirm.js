// =============================================================================
// Confirm page: Cancel modal（フォーカス管理・トラップ・Esc 対応）
// =============================================================================

/** モーダルを開く直前にフォーカスしていた要素を記憶する */
let _modalTrigger = null;

/** フォーカス可能なセレクタ */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * キャンセル確認モーダルを開く
 * @param {HTMLElement} [trigger] - 開くきっかけになった要素（閉じ後にフォーカスを戻す）
 */
function openCancelModal(trigger) {
  const modal = document.getElementById('cancelModal');
  _modalTrigger = trigger || document.activeElement;
  modal.classList.remove('hidden');
  // 最初のフォーカス可能要素へ移動
  const first = modal.querySelector(FOCUSABLE);
  if (first) first.focus();
}

/** キャンセル確認モーダルを閉じる */
function closeCancelModal() {
  const modal = document.getElementById('cancelModal');
  modal.classList.add('hidden');
  // フォーカスをトリガー要素に戻す
  if (_modalTrigger && typeof _modalTrigger.focus === 'function') {
    _modalTrigger.focus();
  }
  _modalTrigger = null;
}

// 確認ページ: キャンセルボタン → モーダルを表示
document.getElementById('btnConfirmCancel').addEventListener('click', function () {
  openCancelModal(this);
});

// モーダル: キャンセル（閉じるだけ）
document.getElementById('cancelModalClose').addEventListener('click', () => {
  closeCancelModal();
});

// モーダル: OK → データをリセットしアップロード画面へ
document.getElementById('cancelModalOk').addEventListener('click', () => {
  closeCancelModal();
  resetPage();
  location.hash = '#upload';
});

// モーダル: オーバーレイクリックで閉じる
document.getElementById('cancelModal').addEventListener('click', function (e) {
  if (e.target === this) closeCancelModal();
});

// モーダル: Esc キーで閉じる
document.addEventListener('keydown', e => {
  const modal = document.getElementById('cancelModal');
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
    closeCancelModal();
  }
});

// モーダル: フォーカストラップ（Tab / Shift+Tab をモーダル内に閉じ込める）
document.getElementById('cancelModal').addEventListener('keydown', function (e) {
  if (e.key !== 'Tab') return;
  const focusable = Array.from(this.querySelectorAll(FOCUSABLE));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
  }
});

// =============================================================================
// Confirm page: Submit
// =============================================================================

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
  if (!parsedData || parsedData.length === 0 || !rawCsv) {
    if (parsedData && parsedData.length > 0 && !rawCsv) {
      // CSVテキストのみ復元できなかったケース（送信不可）
      showToast('送信に必要なデータが復元できませんでした。CSVを再度アップロードしてください。', 'error');
    }
    location.hash = '#upload';
    return;
  }

  // チェックボックス・送信ボタンをリセット
  const checkConfirm = document.getElementById('checkConfirm');
  if (checkConfirm) checkConfirm.checked = false;
  btnFinalSubmit.disabled = true;

  // ── サマリー計算（1パスで全集計）────────────────────────────────────────
  const totals = parsedData.reduce((acc, r) => {
    acc.amountExTax += r.amountExTax;
    acc.tax         += r.tax;
    if (r.taxRate === 10) { acc.exTax10 += r.amountExTax; acc.tax10 += r.tax; }
    else                  { acc.exTax8  += r.amountExTax; acc.tax8  += r.tax; }
    return acc;
  }, { amountExTax: 0, tax: 0, exTax10: 0, tax10: 0, exTax8: 0, tax8: 0 });

  const totalAmountExTax = totals.amountExTax;
  const totalTax         = totals.tax;
  const totalAmountInTax = totalAmountExTax + totalTax;
  const { exTax10, tax10, exTax8, tax8 } = totals;

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
    const st = rows.reduce((acc, r) => {
      acc.amountExTax += r.amountExTax;
      acc.tax         += r.tax;
      if (r.taxRate === 10) acc.tax10 += r.tax;
      else                  acc.tax8  += r.tax;
      return acc;
    }, { amountExTax: 0, tax: 0, tax8: 0, tax10: 0 });
    const storeAmountExTax = st.amountExTax;
    const storeTax         = st.tax;
    const storeTotal       = storeAmountExTax + storeTax;
    const storeTax8        = st.tax8;
    const storeTax10       = st.tax10;

    // アコーディオンカード
    const card = document.createElement('div');
    card.className = 'store-accordion';

    // ヘッダー行
    const header = document.createElement('div');
    header.className = 'store-accordion__header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'false');
    header.innerHTML =
      `<span class="slh-col slh-col--name store-accordion__code">${escapeHtml(storeCode)}</span>` +
      `<span class="slh-col slh-col--amount">${fmt(storeTotal)}</span>` +
      `<span class="slh-col slh-col--extax">${fmt(storeAmountExTax)}</span>` +
      `<span class="slh-col slh-col--tax">${fmt(storeTax)}</span>` +
      `<span class="slh-col slh-col--tax8"><span class="store-tax-val">${storeTax8.toLocaleString('ja-JP')}円</span></span>` +
      `<span class="slh-col slh-col--tax10"><span class="store-tax-val">${storeTax10.toLocaleString('ja-JP')}円</span></span>` +
      `<span class="slh-col slh-col--toggle"><i class="fa-solid fa-chevron-down store-accordion__icon"></i></span>`;

    /** アコーディオン開閉ヘルパー（aria-expanded も同期） */
    const toggleAccordion = () => {
      const isOpen = card.classList.toggle('is-open');
      header.setAttribute('aria-expanded', String(isOpen));
    };

    header.addEventListener('click', toggleAccordion);
    header.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleAccordion();
      }
    });

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
  });
}
