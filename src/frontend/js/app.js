console.log('App initialized');

// =============================================================================
// DOM references
// =============================================================================
const dropZone    = document.getElementById('dropZone');
const btnSelectFile = document.getElementById('btnSelectFile');
const fileInput   = document.getElementById('fileInput');
const btnSubmit   = document.getElementById('btnSubmit');
const errorCard   = document.getElementById('errorCard');
const alertList   = document.getElementById('alertList');
const toast       = document.getElementById('toast');
const toastClose  = document.getElementById('toastClose');

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

// =============================================================================
// Toast helpers
// =============================================================================

/** @param {string} message */
function showToast(message) {
  // テキストノードだけ差し替える（アイコン・閉じるボタンは残す）
  toast.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) node.textContent = ' ' + message + ' ';
  });
  toast.classList.remove('hidden');
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
  // ファイル選択ボタンのイベントは innerHTML 書き換えで消えるため再バインド
  dropZone.querySelector('#btnSelectFile').addEventListener('click', () => fileInput.click());
}

/**
 * dropZone を成功表示に切り替える
 * @param {string} fileName
 */
function setDropZoneSuccess(fileName) {
  dropZone.innerHTML = `
    <i class="fa-regular fa-circle-check drop-zone__icon drop-zone__icon--success"></i>
    <p class="drop-zone__text drop-zone__text--success">
      📄 <strong>${fileName}</strong> を読み込みました
    </p>
    <button class="btn btn-select-file" id="btnSelectFile">
      <i class="fa-regular fa-folder-open"></i> 別のファイルを選択
    </button>
    <input type="file" id="fileInput" accept=".csv" hidden />
  `;
  dropZone.classList.add('is-success');
  // 再バインド
  dropZone.querySelector('#btnSelectFile').addEventListener('click', () =>
    dropZone.querySelector('#fileInput').click()
  );
  dropZone.querySelector('#fileInput').addEventListener('change', function () {
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
      rawCsv    = text;
      parsedData = rows;
    } else {
      // エラー: 保持データをクリア
      rawCsv    = null;
      parsedData = null;
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
    btnSubmit.disabled = true;
  } else {
    // エラーなし → dropZone を成功表示に → errorCard 非表示 → 送信ボタン活性
    setDropZoneSuccess(fileName || '');
    errorCard.classList.add('hidden');
    btnSubmit.disabled = false;
  }
}

