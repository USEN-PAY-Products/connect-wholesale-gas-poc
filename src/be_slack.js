// =============================================================================
// be_slack.js
//
// ランタイムエラー発生時に Slack へ通知するドメイン。
// be_utils.js の logError_() からフックされる（BE）。
// FE の window.onerror / unhandledrejection は reportClientError() 経由でここに合流する。
//
// 設計ドキュメント:
//   docs/plan/runtime_error_slack_notification_design.md
//   docs/plan/runtime_error_slack_notification_tech_selection.md
//
// 公開関数:
//   reportClientError(payload, sessionToken) ← フロントから google.script.run で呼ばれる
//
// 依存:
//   be_utils.js … logError_(), success_()（reportClientError から使用）
//
// 【重要な設計条件】
//   本ファイルの関数群は be_config.js の getConfig_() を一切経由しない。
//   getConfig_() は無関係な必須プロパティ（DRIVE_ROOT_FOLDER_ID 等）が未設定だと
//   例外を投げる仕様のため、これを経由すると「設定不備」と「Slack通知」が道連れで
//   失敗する自己矛盾が生じる。そのため PropertiesService から直接値を読む。
// =============================================================================

// =============================================================================
// 通知要否判定（業務エラー除外ルール）
// =============================================================================

/** メッセージの先頭一致で除外する業務エラーの接頭辞（詳細は設計ドキュメント §2-1）。 */
const SLACK_EXCLUDE_PREFIXES_ = [
  'UNAUTHORIZED:',
  'NOT_REGISTERED:',
];

/** メッセージの部分一致で除外する業務エラー文言（詳細は設計ドキュメント §2-1）。 */
const SLACK_EXCLUDE_SUBSTRINGS_ = [
  '契約が終了しているため',
  '他の操作と競合したため更新できませんでした',
  '請求書受付期間を過ぎているため',
  '今月は既に新規の請求書が登録されています',
  '異議申立期間を過ぎているため',
  'CSVヘッダーの列数が不正です',
  '列目が不正',
  'CSVの列数がフォーマット定義と一致しません',
  'CSVヘッダーに誤りがあります',
  '税抜額または税率に数値として解釈できない値',
  'CSVに該当データが存在しないため税額を検証できません',
  'の調整が±1円を超えています',
  '桁）を超えています',
  // ── ここから下: FE(ブラウザ)由来の「ノイズ」除外 ──────────────────────────
  // 業務エラーではなく、ブラウザ自体の仕様上スタックトレース等の有用な情報が
  // 一切取れない定型メッセージ。調査のしようがなく、通知しても対応不能なノイズに
  // しかならないため、ここで一括除外する（多くのエラー監視SaaS: Sentry/Bugsnag等の
  // デフォルト除外リストにも同様の定番パターンとして含まれる、業界共通のノイズ）。
  //   - 'Script error.': クロスオリジン/不透明化されたスクリプトのエラーである場合に
  //     ブラウザがwindow.onerrorへ渡す定型プレースホルダ。event.error が null になり
  //     message/stackとも実質空になる（reportClientError_ 側で err.stack も空文字送信）。
  //   - 'ResizeObserver loop': 本アプリはResizeObserverを使用していないが、将来の
  //     機能追加や埋め込みリソースが内部的に使う可能性に備えた予防的エントリ
  //     （'ResizeObserver loop limit exceeded' 'ResizeObserver loop completed with
  //     undelivered notifications.' の両方の亜種を前方一致気味にカバーする）。
  'Script error.',
  'ResizeObserver loop',
];


/**
 * 与えられたエラーが Slack 通知対象（システムエラー）かどうかを判定する。
 * ホワイトリスト方式（除外リストのみ管理）とし、除外パターンに該当しない限り
 * 通知対象とする（＝将来の実装漏れは「誤って通知される」側に倒す安全設計）。
 * 除外対象は大きく2種類: (1) 業務エラー（ユーザー起因・対応不要な既知の失敗）、
 * (2) ブラウザ由来の調査不能なノイズ（'Script error.' 等。詳細は
 * SLACK_EXCLUDE_SUBSTRINGS_ 内のコメント参照）。
 *
 * @param {*} err - Error オブジェクト、または任意の値（省略可）
 * @returns {boolean} true: 通知する / false: 通知しない
 */
function shouldNotifySlack_(err) {
  // error 引数を省略して logError_ を呼ぶ箇所（例: be_server.js の
  // getServerAccountInfo_ 内の一部ログ）があるため、err 未定義時は安全側で
  // 通知をスキップする。直後に throw され、呼び出し元 catch が改めて
  // 完全な err 付きで logError_ を呼び直すため、通知の取りこぼしにはならない。
  if (!err) return false;

  const message = String((err && err.message) || err || '');
  if (SLACK_EXCLUDE_PREFIXES_.some(function (p) { return message.indexOf(p) === 0; })) {
    return false;
  }
  if (SLACK_EXCLUDE_SUBSTRINGS_.some(function (s) { return message.indexOf(s) !== -1; })) {
    return false;
  }
  return true;
}

// =============================================================================
// 重複抑制（Rate Limiting）
// =============================================================================

/** 重複抑制の TTL（秒）。60秒以内の同一 tag・同一 message は Slack 送信のみスキップする。 */
const SLACK_DEDUP_TTL_SECONDS_ = 60;

/**
 * 重複抑制キー生成用に message を正規化する。
 * FE 由来のメッセージは reportClientError() で
 * '[FE] <clientErrorId> <rawMessage>' という形式に組み立てられるが、
 * clientErrorId は呼び出しごとに異なるランダムな値（FE の generateClientErrorId_()、
 * もしくは未指定時は BE 側で生成する UUID 先頭8桁）のため、これを含めたまま
 * message.slice(0, 50) で先頭50文字を切り出すと、同一エラーが短時間に連続発生しても
 * 毎回別キー扱いになり、重複抑制が実質的に機能しない。
 * tag === 'FE' の場合のみ先頭の '[FE] <clientErrorId> ' 部分を取り除き、
 * rawMessage 相当の文字列を返す（tag !== 'FE' の場合は message をそのまま返す）。
 *
 * @param {string} tag
 * @param {string} message
 * @returns {string} 重複抑制キーの生成に使う正規化済み文字列
 */
function normalizeMessageForDedup_(tag, message) {
  const msg = String(message || '');
  if (tag !== 'FE') return msg;
  return msg.replace(/^\[FE\]\s+\S+\s+/, '');
}

/**
 * 直近 SLACK_DEDUP_TTL_SECONDS_ 秒以内に同一 tag・同一 message
 * （FE の場合は normalizeMessageForDedup_ で clientErrorId を取り除いた正規化後の文字列）
 * の通知が既に行われたかどうかを CacheService で判定する。
 * Cache 障害時は「抑制しない」側に倒す（通知の取りこぼしより多少の重複を許容）。
 *
 * @param {string} tag
 * @param {string} message
 * @returns {boolean} true: 直近重複あり（送信スキップ） / false: 重複なし
 */
function isDuplicateRecent_(tag, message) {
  try {
    const normalized = normalizeMessageForDedup_(tag, message);
    const key = 'slack_dedup:' + String(tag) + ':' + normalized.slice(0, 50);
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return true;
    cache.put(key, '1', SLACK_DEDUP_TTL_SECONDS_);
    return false;
  } catch (_) {
    return false;
  }
}

// =============================================================================
// 調査のヒント（tag別の一次切り分けヒント）
// =============================================================================

/**
 * tag・message の内容から、調査担当者向けの一次切り分けヒント（定型文）を返す。
 * @param {string} tag
 * @param {string} message
 * @returns {string} ヒント文（該当なしの場合は空文字）
 */
function buildInvestigationHint_(tag, message) {
  const msg = String(message || '');
  if (tag === 'Invoice' || tag === 'CsvMapper' || tag === 'Schema') {
    if (msg.indexOf('staging DROP') !== -1) {
      return '手動DROPが必要か確認してください（BQ_LOCATION設定ミスの可能性）';
    }
    if (msg.indexOf('Load Job') !== -1 || msg.indexOf('load job') !== -1) {
      return 'CSVの文字エンコーディング／BQスキーマ定義を確認してください';
    }
    if (msg.indexOf('トランザクション') !== -1) {
      return 'BQ Jobsコンソールでジョブの成否（COMMIT/ROLLBACK）を確認してください';
    }
    return 'BQ Jobsコンソールおよび Cloud Logging の詳細を確認してください';
  }
  if (tag === 'Auth') {
    return 'wholesaler_userテーブルの該当メール登録有無を確認してください';
  }
  if (tag === 'FE') {
    return '該当clientErrorIdでCloud Loggingを検索しスタックトレース全文を確認してください';
  }
  return '';
}

// =============================================================================
// 調査用リンク生成
// =============================================================================

/**
 * Cloud Logging Logs Explorer への検索条件付きディープリンクを生成する。
 * ※ このURL形式はGCP公式ドキュメントでの一次情報記載は確認できておらず、
 *   実務観測パターンに基づく。将来GCP側の仕様変更で崩れるリスクは非ゼロ。
 *
 * @param {string} searchText - 検索したい文字列（ID等）
 * @param {string} gcpProjectId
 * @returns {string} Cloud Logging の URL（gcpProjectId が空なら空文字）
 */
function buildCloudLoggingUrl_(searchText, gcpProjectId) {
  if (!gcpProjectId) return '';
  const query = 'severity>=ERROR ' + String(searchText || '');
  return 'https://console.cloud.google.com/logs/query;query=' + encodeURIComponent(query) +
    '?project=' + encodeURIComponent(gcpProjectId);
}

/**
 * 実行中の GAS プロジェクトの実行ログ（Executions）ダッシュボードへのリンクを生成する。
 * ScriptApp.getScriptId() で実行時に自己解決するため、dev/prod/local の別 scriptId を
 * ハードコードする必要がない。
 *
 * @returns {string}
 */
function buildGasExecutionsUrl_() {
  return 'https://script.google.com/home/projects/' + ScriptApp.getScriptId() + '/executions';
}

// =============================================================================
// Slack メッセージ組み立て
// =============================================================================

/** context から実装済みの具体的IDを抽出する対象キー一覧。 */
const SLACK_CONTEXT_ID_KEYS_ = ['invoiceUuid', 'stagingId', 'storeInvoiceId', 'parentInvoiceId'];

/**
 * Slack 通知本文（Block Kit 形式）を組み立てる。
 * 表示ラベルはすべて日本語。5W1H（いつ・どこで・誰が・何を・なぜ・どう対応するか）は
 * 設計ドキュメント内の情報整理軸として使うのみで、本文側は絵文字の羅列や罫線・
 * 全角記号による装飾を避け、"ラベル: 値" の短い行を並べるだけの簡潔な体裁にする
 * （1行ごとに絵文字を置く・罫線で囲む・見出し＋箇条書きで手順書のように書く、
 * といった体裁は記号の情報量が多すぎて逆に読みにくくなるため採用しない）。
 *
 * ctx.wholesalerId / ctx.wholesalerName は、be_invoice.js 等の BE 呼び出し元から
 * BigQuery 由来の accountInfo.wholesaler_name がそのまま渡ってくる経路と、
 * reportClientError() 経由で FE（ブラウザ改ざん可能な入力）から渡ってくる経路の
 * 両方が存在する。同様に message・err.message・err.stack、ctx[key]（invoiceUuid・
 * stagingId・storeInvoiceId・parentInvoiceId）、ctx.actionLabel・ctx.fileName も、
 * CSVアップロード内容（例: validateCsvHeader_ が実際のヘッダーセル値をそのまま Error に
 * 埋め込むケースや、ユーザーが任意に付けた元CSVファイル名そのもの）や FE からの入力、
 * DB由来の値に由来し得るため、任意の Slack 特殊記法を含みうる。
 * これらは本関数が Slack mrkdwn 本文へ実際に埋め込む唯一の場所であるため、
 * 埋め込み直前に escapeSlackText_() を通し、値に <!channel> や
 * <@U...> のような Slack 特殊記法が含まれていてもメンション/リンクとして
 * 展開されないようにする（呼び出し元側での二重エスケープを避けるため、
 * エスケープはこの関数の中でのみ行う。呼び出し元でエスケープ済みの値を渡さないこと。
 * ただし Cloud Logging 検索リンク用の searchText は ctx[key] の生値を別途参照して
 * URLエンコードするため、idPairs表示用のエスケープとは独立しており影響しない）。
 *
 * @param {string} tag
 * @param {string} message
 * @param {*} err
 * @param {Object} [context] - { wholesalerId, wholesalerName, actionLabel, fileName, invoiceUuid, stagingId, storeInvoiceId, parentInvoiceId, ... }
 * @returns {{ text: string, blocks: Array<Object> }}
 */
function buildSlackBlocks_(tag, message, err, context) {
  const ctx = context || {};
  const props = PropertiesService.getScriptProperties();
  const env = props.getProperty('ENV') || '不明';
  const gcpProjectId = props.getProperty('GCP_PROJECT_ID') || '';

  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  const whoParts = [];
  if (ctx.wholesalerId)   whoParts.push('wholesaler_id=' + escapeSlackText_(ctx.wholesalerId));
  if (ctx.wholesalerName) whoParts.push(escapeSlackText_(ctx.wholesalerName));
  const who = whoParts.length > 0 ? whoParts.join(' / ') : '不明';

  // ctx.actionLabel は現状すべてのBE呼び出し元で固定の日本語文言（例: '請求書登録'）だが、
  // 将来外部入力由来の値が渡された場合に備え、他フィールドと同じ方針でエスケープしておく。
  const what = escapeSlackText_(ctx.actionLabel || String(tag || '不明'));

  // message・err.message・err.stack は CSVアップロード内容や FE 入力に由来し得るため、
  // Slack mrkdwn 本文へ埋め込む直前に escapeSlackText_() を通す。
  const safeMessage   = escapeSlackText_(message);
  const errMessage    = escapeSlackText_((err && err.message) ? String(err.message) : String(message || '(不明なエラー)'));
  const errStackLines = escapeSlackText_((err && err.stack) ? String(err.stack).split('\n').slice(0, 3).join('\n') : '');

  // 判明している具体的ID（invoiceUuid/stagingId/storeInvoiceId/parentInvoiceId）。
  // ctx[key] は be_invoice.js 等の BE 呼び出し元からDB由来の値がそのまま渡ってくるため、
  // 表示用に escapeSlackText_() を通す（key自体は固定のキー名なのでエスケープ不要）。
  // searchText（下記）は Cloud Logging検索クエリ専用に ctx[key] の生値を別途参照するため、
  // ここでのエスケープは検索リンクの生成には影響しない。
  const idPairs = [];
  SLACK_CONTEXT_ID_KEYS_.forEach(function (key) {
    if (ctx[key]) idPairs.push(key + ': ' + escapeSlackText_(ctx[key]));
  });

  const hintLine = buildInvestigationHint_(tag, message);

  const searchText = idPairs.length > 0
    ? SLACK_CONTEXT_ID_KEYS_.map(function (key) { return ctx[key]; }).filter(Boolean).join(' ')
    : String(message || '');
  const loggingUrl    = buildCloudLoggingUrl_(searchText, gcpProjectId);
  const executionsUrl = buildGasExecutionsUrl_();

  const sourceLabel = tag === 'FE' ? '[FE]' : '[BE]';

  // タイトルは「何が失敗したか」が一目でわかれば十分。絵文字は先頭に1つだけとし、
  // 【】のような装飾や罫線は使わない（1行ごとに絵文字を並べ、罫線で囲むだけの見た目は
  // 情報よりも記号のほうが目立ってしまい、かえって読みにくいため廃止した）。
  const title = '🔴 ' + sourceLabel + ' ' + what + 'に失敗';

  // 詳細情報は "ラベル: 値" 形式に統一する。従来はラベルを全角スペースで手動整列していたが、
  // Slackのmrkdwnはプロポーショナルフォントで描画されるため実際には桁が揃わない
  // （見た目上の整列は諦め、コロンの前後は通常の半角スペース1つに統一する）。
  const detailLines = [
    '対象卸: ' + who,
    '操作: ' + what,
  ];
  // ファイル名はCSVアップロード系（sendInvoiceData/resubmitInvoiceData/bulkResubmitInvoiceData）
  // からのみ渡ってくる想定の任意項目。未指定の呼び出し元では従来通り行自体を出さない。
  if (ctx.fileName) {
    detailLines.push('ファイル名: ' + escapeSlackText_(ctx.fileName));
  }
  detailLines.push(
    '発生箇所: ' + String(tag || '不明') + ' / ' + safeMessage,
    'エラー内容: ' + errMessage + (errStackLines ? '\n' + errStackLines : '')
  );
  if (idPairs.length > 0) {
    detailLines.push('ID: ' + idPairs.join(' / '));
  }

  // 末尾のヒント・リンクも「調査のヒント:」のような見出しや「・」の箇条書き記号は使わず、
  // 文章として自然に添える程度にとどめる。
  const footerLines = [];
  if (hintLine) footerLines.push(hintLine);
  const linkParts = [];
  if (loggingUrl)    linkParts.push('<' + loggingUrl + '|🔍 Cloud Logging>');
  if (executionsUrl) linkParts.push('<' + executionsUrl + '|⚙️ 実行ログ>');
  if (linkParts.length > 0) footerLines.push(linkParts.join('   '));

  const lines = [title, now + ' JST (env=' + env + ')', ''].concat(detailLines);
  if (footerLines.length > 0) {
    lines.push('');
    lines.push(footerLines.join('\n'));
  }

  const text = lines.join('\n');
  return {
    text: text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text } },
    ],
  };
}

// =============================================================================
// Slack 通知本体
// =============================================================================

/**
 * ランタイムエラーを Slack へ通知する。be_utils.js の logError_() からフックされる。
 * 通知要否判定→Webhook設定確認→重複抑制判定→メッセージ組み立て→Slack送信の順に処理する。
 * Webhook設定確認を重複抑制判定より先に行うのは、isDuplicateRecent_ がCacheへの書き込みを
 * 伴うため（重複抑制判定を先に行うと、Webhook未設定＝送信不可能なケースでも無駄にCacheキーを
 * 消費してしまい、後からWebhookを設定した直後の最初の通知が TTL(60秒) 以内という理由だけで
 * 誤って抑制されてしまう副作用が生じるため）。
 * 全体を単一 try/catch で包み、いかなる内部エラーも外に漏らさない
 * （呼び出し元の logError_ 側にも二重防御の try/catch があるが、ここでも独立して防御する）。
 *
 * UrlFetchApp.fetch() は muteHttpExceptions: true のため、Slack側が 4xx/5xx
 * （Webhook URL失効・ペイロード不正・レート制限超過等）を返しても例外を投げず、
 * 何も分からないままサイレントに終わってしまう。これに気づけるよう、応答コードが
 * 2xx以外の場合のみ Logger.log で警告を残す（送信失敗の再試行・例外伝播は行わない。
 * あくまで Cloud Logging から後で気づけるようにすることのみが目的）。
 *
 * @param {string} tag
 * @param {string} message
 * @param {*} [err]
 * @param {Object} [context]
 */
function notifySlackError_(tag, message, err, context) {
  try {
    if (!shouldNotifySlack_(err)) return;

    const webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
    if (!webhookUrl) return; // 未設定環境では何もしない（例外は投げない。Cacheも消費しない）

    if (isDuplicateRecent_(tag, message)) return;

    const payload = buildSlackBlocks_(tag, message, err, context);

    const response = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const responseCode = response.getResponseCode();
    if (responseCode < 200 || responseCode >= 300) {
      Logger.log(
        '[WARN][Slack] Webhook送信がエラー応答を返しました（HTTP ' + responseCode + '）: ' +
        sanitizeLogMessage_(response.getContentText())
      );
    }
  } catch (_) {
    // 通知処理自体のいかなる想定漏れも、呼び出し元（logError_）へは絶対に伝播させない。
  }
}

// =============================================================================
// Slack特殊記法のエスケープ
// =============================================================================

/**
 * Slack mrkdwn の特殊記法（<!channel>・<!here> 等のメンション、<@U.../> のような
 * ユーザー参照、<url|label> 形式のリンク）としての意図しない展開を防ぐため、
 * Slack公式の推奨に従い &, <, > をエスケープする。
 * 変換順序が重要（& を最初にエスケープしないと、<, > のエスケープ結果に含まれる
 * & まで二重エスケープしてしまう）。
 *
 * reportClientError() が受け取る payload はブラウザ（クライアント）側で自由に
 * 内容を書き換えて送信できるため、Error/context に格納する前に本関数を通し、
 * 値の中に <!channel> や <@U...> のような文字列が含まれていても Slack 側で
 * メンション/リンクとして解釈されないようにする。
 *
 * @param {*} text
 * @returns {string} エスケープ済み文字列（null/undefined は空文字扱い）
 */
function escapeSlackText_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =============================================================================
// FE エラー受信（公開関数）
// =============================================================================

/**
 * reportClientError() が受け取る payload.clientErrorId の許容パターン
 * （英数字・ハイフン・アンダースコアのみ、1〜32文字）。
 * FE の generateClientErrorId_() は8桁の16進文字列を生成するが、payload はブラウザ側で
 * 自由に書き換え可能な入力のため、この前提が崩れた値がそのまま来る可能性がある。
 * 特に空白を含む値を送られると、normalizeMessageForDedup_() の
 * "[FE] <clientErrorId> " 接頭辞除去が /^\[FE\]\s+\S+\s+/（\S+ = 空白を含まない
 * 前提）を使っているため除去が正しく行われず、同一エラーでも呼び出しごとに異なる
 * 重複抑制キーになってしまう（＝重複抑制を容易に回避され、Slack通知スパムを
 * 誘発し得る）。このパターンに一致しない値は信用せず、reportClientError() 内で
 * サーバ側生成の8桁hex IDにフォールバックする。
 */
const CLIENT_ERROR_ID_PATTERN_ = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * フロントエンドの window.onerror / unhandledrejection から
 * google.script.run 経由で呼ばれる公開関数。受け取った内容を
 * logError_('FE', ...) に合流させ、以降は BE と同じ通知経路に乗せる。
 *
 * payload の各フィールドはブラウザ側で自由に改ざん可能な入力のため Slack mrkdwn
 * 注入のリスクがあるが、エスケープは Slack 本文へ実際に埋め込む buildSlackBlocks_()
 * 側で一元的に行うため、ここではいずれのフィールドもエスケープせず渡す
 * （二重エスケープ防止。url/ua は現状 buildSlackBlocks_ で未使用だが、将来表示に
 * 使う際も同じ理由でそちら側でエスケープすること。Cloud Logging 側の Logger.log
 * 出力（be_utils.js の logError_）にも生の値を残したいため、Slack向けエスケープは
 * Slack本文組み立て箇所だけに閉じ込める）。
 * 同様にブラウザ側は任意の長さの文字列を送信できるため、message/stack/url/ua に加え
 * wholesalerId/wholesalerName も、値がある場合のみ長さ上限（100文字）で切り詰めてから
 * context へ格納する（Slack Webhook送信ペイロードの肥大化による送信遅延・失敗を防ぐため）。
 * clientErrorId のみは他フィールドと異なり、切り詰めではなく CLIENT_ERROR_ID_PATTERN_ に
 * よる形式検証を行い、不一致の場合はサーバ側生成IDに全面的に差し替える（詳細は
 * CLIENT_ERROR_ID_PATTERN_ のJSDoc参照）。
 *
 * @param {{ clientErrorId?: string, message?: string, stack?: string, url?: string, ua?: string, wholesalerId?: string, wholesalerName?: string }} payload
 * @param {string} [sessionToken] - 現状は未使用（Who は FE(sessionStorage) 由来の値をそのまま使う。
 *   ここで sessionToken による再認証は行わない。再認証エラーが元のクライアントエラー通知を
 *   握りつぶしてしまうのを避けるため）。
 * @returns {{ status: 'success', data: null }}
 */
function reportClientError(payload, sessionToken) {
  try {
    const p = payload || {};
    // payload.clientErrorId はブラウザ側で自由な文字列に書き換え可能なため、
    // CLIENT_ERROR_ID_PATTERN_ に一致しない値（空白・Slack特殊記法・空文字・
    // 過剰な長さ等）は信用せず、サーバ側生成の8桁hex IDに差し替える
    // （重複抑制回避によるSlack通知スパムの防止）。
    const rawClientErrorId = String(p.clientErrorId || '');
    const clientErrorId = CLIENT_ERROR_ID_PATTERN_.test(rawClientErrorId)
      ? rawClientErrorId
      : Utilities.getUuid().slice(0, 8);
    const rawMessage = String(p.message || '(no message)').slice(0, 500);
    const message = '[FE] ' + clientErrorId + ' ' + rawMessage;

    const err = new Error(message);
    err.stack = String(p.stack || '').slice(0, 2000);

    // wholesalerId/wholesalerName は message/stack/url/ua 同様、値がある場合のみ
    // 長さ上限（100文字）で切り詰める。falsy値（未送信等）はそのまま null を維持し、
    // buildSlackBlocks_ 側のtruthyチェックで「不明」表示にフォールバックさせる。
    const context = {
      wholesalerId:   p.wholesalerId   ? String(p.wholesalerId).slice(0, 100)   : null,
      wholesalerName: p.wholesalerName ? String(p.wholesalerName).slice(0, 100) : null,
      actionLabel:    'フロントエンドエラー',
      url:            String(p.url || '').slice(0, 300),
      ua:             String(p.ua || '').slice(0, 300),
    };

    logError_('FE', message, err, context);
    return success_(null);
  } catch (e) {
    // ここに到達するのは極めて異常なケースのみ（logError_ 自体が二重防御済みのため）。
    // CODING_RULES.md §4 に準拠し throw するが、FE 側の failureHandler は再送信を
    // 行わない設計のため無限ループは発生しない。
    throw new Error('エラーレポートの送信に失敗しました。');
  }
}
