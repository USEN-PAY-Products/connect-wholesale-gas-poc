// =============================================================================
// test/be_slack.test.js
//
// ランタイムエラー Slack 通知機能のユニットテスト。
// 設計ドキュメント: docs/plan/runtime_error_slack_notification_design.md §10
//
// src/be_utils.js・src/be_slack.js を「未改変のまま」vm サンドボックスへ読み込み、
// GAS のグローバル API（PropertiesService 等）をモックとして注入して検証する。
// 対象ソースへ module.exports 等を追加することは禁止（GAS本番実行が
// `ReferenceError: module is not defined` で壊れるため）なので、
// require() ではなく vm.createContext + vm.runInContext を用いる。
//
// 検証する安全性（詳細は設計書 §10 参照）:
//   1. notifySlackError_ が異常入力（context省略・fetch例外）でも例外を外に投げない
//   2. SLACK_WEBHOOK_URL 未設定時は例外なくスキップする
//   3. shouldNotifySlack_ が既知の業務エラー文言で false、それ以外で true を返す
//   4. logError_ が、notifySlackError_ が例外を投げても自身は例外を投げない
//   5. PropertiesService 読み取りが getConfig_ を経由していない
//   6. 重複抑制キーがFE由来message先頭のclientErrorId（ランダム値）に引きずられない
//   7. reportClientError が受け取るpayloadのSlack特殊記法（<!channel>等）をエスケープする
//   8. Cacheが正常な場合、レートリミット（60秒以内の同一tag・同一messageの重複抑制）が
//      意図通り機能し、tag・messageいずれかが異なる場合は誤って抑制しない
//   9. buildSlackBlocks_ が ctx.wholesalerId/ctx.wholesalerName をエスケープする
//      （be_invoice.js 等の BE 呼び出し元から BigQuery 由来の wholesaler_name がそのまま
//      渡ってくる経路も対象）し、かつ FE 経由（reportClientError）で二重エスケープしない
//  10. buildSlackBlocks_ が message/err.message/err.stack もエスケープする
//      （CSVアップロード内容やFE入力由来の例外メッセージも対象）し、
//      かつ FE 経由（reportClientError）で二重エスケープしない
//  11. buildSlackBlocks_ が idPairs（ctx.invoiceUuid/stagingId/storeInvoiceId/
//      parentInvoiceId）もエスケープする（Cloud Logging検索リンクの生成には影響しない）
//  12. buildSlackBlocks_ が ctx.actionLabel もエスケープする
//  13. notifySlackError_ は SLACK_WEBHOOK_URL 未設定時、重複抑制判定（Cacheへの書き込み）
//      自体を行わない（Webhook設定確認 → 重複抑制判定 の順で処理する）
//  14. reportClientError は wholesalerId/wholesalerName を message/stack/url/ua 同様
//      長さ上限（100文字）で切り詰めてから context へ格納する（Slack Webhook送信ペイロード
//      肥大化防止。falsy値はnullのまま維持される）
//  15. reportClientError は payload.clientErrorId が CLIENT_ERROR_ID_PATTERN_
//      （英数字・ハイフン・アンダースコアのみ、1〜32文字）に一致しない場合
//      （空白混入・Slack特殊記法・過剰な長さ等）、信用せずサーバ側生成IDに
//      差し替える（空白混入による normalizeMessageForDedup_ の重複抑制回避＝
//      Slack通知スパムを防止する）
//  16. buildSlackBlocks_ は err.stack の1行目が err.message と同一内容を含む場合
//      （GoogleJsonResponseException 等、GAS/V8の一般的なスタックトレース形式）、
//      その1行を除去してから表示する（「エラー内容」行とスタックトレース1行目で
//      同じ文言が重複表示される実運用不具合の回帰確認）。無関係な内容のstack
//      （FE由来など）はそのまま全行維持する。
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BE_UTILS_PATH = path.join(__dirname, '..', 'src', 'be_utils.js');
const BE_SLACK_PATH = path.join(__dirname, '..', 'src', 'be_slack.js');

const BE_UTILS_SRC = fs.readFileSync(BE_UTILS_PATH, 'utf8');
const BE_SLACK_SRC = fs.readFileSync(BE_SLACK_PATH, 'utf8');

/**
 * GAS のグローバル API をモックした vm サンドボックスを作成し、
 * be_utils.js・be_slack.js を未改変のまま読み込んで返す。
 *
 * @param {Object} [options]
 * @param {Object} [options.scriptProperties] - PropertiesService の初期値（例: { SLACK_WEBHOOK_URL: '...' }）
 * @param {boolean} [options.urlFetchThrows] - true の場合 UrlFetchApp.fetch() が例外を投げる
 * @param {boolean} [options.cacheThrows] - true の場合 CacheService の get/put が例外を投げる
 * @returns {vm.Context & { __fetchCalls: Array, __loggerLines: Array<string>, __scriptProps: Object, __cachePutCalls: Array }}
 */
function createSandbox(options) {
  const opts = options || {};
  const scriptProps = Object.assign({}, opts.scriptProperties);
  const cacheStore = {};
  const fetchCalls = [];
  const loggerLines = [];
  const cachePutCalls = [];

  const sandbox = {
    // Node 標準の console は GAS には存在しないが、テスト用に注入しても実害はない。
    console: console,

    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (key) {
            return Object.prototype.hasOwnProperty.call(scriptProps, key) ? scriptProps[key] : null;
          },
          setProperty: function (key, value) {
            scriptProps[key] = value;
          },
        };
      },
    },

    UrlFetchApp: {
      fetch: function (url, params) {
        if (opts.urlFetchThrows) {
          throw new Error('UrlFetchApp.fetch は失敗しました（テスト用の疑似障害）');
        }
        fetchCalls.push({ url: url, params: params });
        return {
          getResponseCode: function () { return 200; },
          getContentText: function () { return '{}'; },
        };
      },
    },

    CacheService: {
      getScriptCache: function () {
        return {
          get: function (key) {
            if (opts.cacheThrows) throw new Error('CacheService.get は失敗しました（テスト用の疑似障害）');
            return Object.prototype.hasOwnProperty.call(cacheStore, key) ? cacheStore[key] : null;
          },
          put: function (key, value, ttl) {
            if (opts.cacheThrows) throw new Error('CacheService.put は失敗しました（テスト用の疑似障害）');
            cacheStore[key] = value;
            // 正常系のレートリミット検証（isDuplicateRecent_ が実際にCacheへ書き込んだか、
            // 何回書き込んだか）用に呼び出し履歴を記録する。
            cachePutCalls.push({ key: key, value: value, ttl: ttl });
          },
        };
      },
    },

    Logger: {
      log: function (msg) {
        loggerLines.push(String(msg));
      },
    },

    ScriptApp: {
      getScriptId: function () { return 'test-script-id'; },
    },

    Utilities: {
      formatDate: function () { return '2026-01-01 00:00:00'; },
      getUuid: function () { return '00000000-0000-0000-0000-000000000000'; },
    },

    // getConfig_ は本来 be_config.js で定義される。ここでは「呼ばれたら即座に分かる」
    // スパイとして定義し、検証5（getConfig_ 非経由の確認）に使う。
    getConfig_: function () {
      sandbox.__getConfigCalled = true;
      throw new Error('getConfig_ はこのテストでは呼ばれない想定です（呼ばれた場合は設計違反）');
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(BE_UTILS_SRC, sandbox, { filename: 'be_utils.js' });
  vm.runInContext(BE_SLACK_SRC, sandbox, { filename: 'be_slack.js' });
  // サンドボックス自身のレルムで Error を生成するためのヘルパーをコンテキスト内に注入する
  // （詳細は makeSandboxError の JSDoc を参照）。
  vm.runInContext(
    'function __makeError(message) { return new Error(message); }',
    sandbox,
    { filename: 'test-helpers.js' }
  );

  sandbox.__fetchCalls = fetchCalls;
  sandbox.__loggerLines = loggerLines;
  sandbox.__scriptProps = scriptProps;
  sandbox.__cachePutCalls = cachePutCalls;
  sandbox.__getConfigCalled = false;

  return sandbox;
}

/**
 * サンドボックス（vm コンテキスト）自身の Error コンストラクタで Error を生成する。
 * node:vm はコンテキストごとに別レルムとなるため、外側の Error で `new Error(...)` すると
 * サンドボックス内での `instanceof Error` が false になる（クロスレルム問題）。
 * これを避けるため、`__makeError` 関数自体を vm.runInContext() でサンドボックス内に
 * 定義しておき（＝関数のクロージャスコープがサンドボックスのグローバルスコープになる）、
 * それを呼び出す形で Error を生成する。こうすることで関数内の `Error` 識別子が
 * サンドボックス自身の Error コンストラクタに解決され、be_utils.js 内の
 * `error instanceof Error` が正しく true になる。
 *
 * @param {vm.Context} sandbox
 * @param {string} message
 * @returns {Error}
 */
function makeSandboxError(sandbox, message) {
  return sandbox.__makeError(message);
}

/**
 * Slack payload の全ブロック（header の plain_text、section の mrkdwn text、
 * section の fields）を連結したテキストを返す。
 * buildSlackBlocks_ が BackOffice(BO) システムの体裁（header＋fields＋divider＋
 * コードブロック）に合わせて複数ブロックに分割されたため、従来 blocks[0].text.text
 * のみを見ていたテストが、内容が存在するブロック全体を横断的に検証できるようにする。
 *
 * @param {Object} payload - JSON.parse(sentPayload) 相当
 * @returns {string}
 */
function allBlocksText(payload) {
  return (payload.blocks || [])
    .map((block) => {
      if (block.text && block.text.text) return block.text.text;
      if (Array.isArray(block.fields)) return block.fields.map((f) => f.text).join('\n');
      return '';
    })
    .join('\n');
}

// =============================================================================
// 検証1: notifySlackError_ が異常入力でも例外を外に投げない
// =============================================================================

test('notifySlackError_: contextが省略されても例外を外に投げない', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  assert.doesNotThrow(() => {
    sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, undefined);
  });
  // context省略でも正常系としてfetchまで到達すること（buildSlackBlocks_がcontext||{}で防御している）
  assert.equal(sandbox.__fetchCalls.length, 1);
});

test('notifySlackError_: UrlFetchApp.fetch が例外を投げても外に例外を投げない', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
    urlFetchThrows: true,
  });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  assert.doesNotThrow(() => {
    sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, { wholesalerId: 1 });
  });
});

test('notifySlackError_: CacheService（重複抑制）が例外を投げても外に例外を投げない', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
    cacheThrows: true,
  });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  assert.doesNotThrow(() => {
    sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});
  });
  // Cache障害時は「抑制しない」側に倒すため、fetchはされる
  assert.equal(sandbox.__fetchCalls.length, 1);
});

// =============================================================================
// 検証2: SLACK_WEBHOOK_URL 未設定時は例外なくスキップする
// =============================================================================

test('notifySlackError_: SLACK_WEBHOOK_URL 未設定時は例外を投げずスキップし、fetchも呼ばれない', () => {
  const sandbox = createSandbox({ scriptProperties: {} });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  assert.doesNotThrow(() => {
    sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});
  });
  assert.equal(sandbox.__fetchCalls.length, 0);
});

// =============================================================================
// 検証3: shouldNotifySlack_ が既知の業務エラー文言で false、それ以外で true を返す
// =============================================================================

test('shouldNotifySlack_: 業務エラー文言（設計書§2-1の除外パターン）は false を返す', () => {
  const sandbox = createSandbox();

  const businessErrorMessages = [
    'UNAUTHORIZED: ログイン情報の取得に失敗しました。再度ログインしてください。',
    'NOT_REGISTERED: このアカウントは登録されていません。管理者にお問い合わせください。',
    'この卸は契約が終了しているため、ご利用いただけません。',
    '他の操作と競合したため更新できませんでした。ページを再読み込みして再度お試しください。',
    '請求書受付期間を過ぎているため、アップロードできません。',
    '今月は既に新規の請求書が登録されています。差し戻しや否認の修正版のアップロードは詳細画面からアップロードしてください。',
    '異議申立期間を過ぎているため、取下げの取り消しはできません。',
    'CSVヘッダーの列数が不正です',
    '3列目が不正な値です',
    'CSVの列数がフォーマット定義と一致しません',
    'CSVヘッダーに誤りがあります',
    '税抜額または税率に数値として解釈できない値が含まれています',
    'CSVに該当データが存在しないため税額を検証できません',
    '税額の調整が±1円を超えています',
    '金額（15桁）を超えています',
  ];

  businessErrorMessages.forEach((msg) => {
    const err = makeSandboxError(sandbox, msg);
    assert.equal(sandbox.shouldNotifySlack_(err), false, '業務エラーとして除外されるべき: ' + msg);
  });
});

test('shouldNotifySlack_: 業務エラーに該当しないシステムエラーは true を返す', () => {
  const sandbox = createSandbox();

  const systemErrorMessages = [
    'Exception: BigQuery のクエリでエラーが発生しました',
    'TypeError: Cannot read properties of undefined (reading \'foo\')',
    '予期しないエラーが発生しました',
    'Drive フォルダの作成に失敗しました',
  ];

  systemErrorMessages.forEach((msg) => {
    const err = makeSandboxError(sandbox, msg);
    assert.equal(sandbox.shouldNotifySlack_(err), true, 'システムエラーとして通知されるべき: ' + msg);
  });
});

test('shouldNotifySlack_: err が未定義/null の場合は安全側で false を返す', () => {
  const sandbox = createSandbox();
  assert.equal(sandbox.shouldNotifySlack_(null), false);
  assert.equal(sandbox.shouldNotifySlack_(undefined), false);
});

// =============================================================================
// 検証4: logError_ が、notifySlackError_ が例外を投げても自身は例外を投げない
// =============================================================================

test('logError_: notifySlackError_ が例外を投げても logError_ 自身は例外を投げない（二重防御）', () => {
  const sandbox = createSandbox();
  // notifySlackError_ をモックに差し替える（be_slack.js の実装は使わず、想定外の例外を強制発生させる）
  sandbox.notifySlackError_ = function () {
    throw new Error('notifySlackError_ 内部の想定外エラー（テスト用）');
  };
  const err = makeSandboxError(sandbox, 'boom');

  assert.doesNotThrow(() => {
    sandbox.logError_('Invoice', 'テストメッセージ', err, {});
  });

  // Slack通知側が例外を投げても、Logger.log によるログ出力自体は必ず実行されていること
  assert.equal(sandbox.__loggerLines.length, 1);
  assert.match(sandbox.__loggerLines[0], /^\[ERROR\]\[Invoice\]/);
});

test('logError_: error 引数を省略して呼んでも例外を投げない（be_server.js 等の既存呼び出しパターン）', () => {
  const sandbox = createSandbox();
  assert.doesNotThrow(() => {
    sandbox.logError_('Auth', '認証失敗: メールアドレスを取得できませんでした');
  });
  assert.equal(sandbox.__loggerLines.length, 1);
  // Slack通知はerror省略時にshouldNotifySlack_が false を返すため、fetchは呼ばれない
  assert.equal(sandbox.__fetchCalls.length, 0);
});

// =============================================================================
// 検証5: PropertiesService 読み取りが getConfig_ を経由していない
// =============================================================================

test('notifySlackError_: PropertiesService を直接読み、getConfig_ を一切経由しない', () => {
  const sandbox = createSandbox({
    scriptProperties: {
      SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy',
      GCP_PROJECT_ID: 'test-project',
      ENV: 'test',
    },
  });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  assert.doesNotThrow(() => {
    sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {
      wholesalerId: 1,
      wholesalerName: 'テスト卸',
    });
  });

  assert.equal(sandbox.__getConfigCalled, false, 'getConfig_() が呼び出された場合は設計違反（PropertiesServiceの直接読み取りが必要）');
  assert.equal(sandbox.__fetchCalls.length, 1, 'Webhook設定済み・システムエラーのため fetch は1回呼ばれるはず');
});

test('logError_: 経由しても getConfig_ を一切経由しない', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  assert.doesNotThrow(() => {
    sandbox.logError_('Invoice', 'システムエラーが発生しました', err, {});
  });
  assert.equal(sandbox.__getConfigCalled, false);
});

// =============================================================================
// 検証6: 重複抑制（isDuplicateRecent_）― FEメッセージの clientErrorId 正規化
//
// reportClientError() が組み立てる message は '[FE] <clientErrorId> <rawMessage>'
// 形式で、clientErrorId は呼び出しごとにランダムな値になる。normalizeMessageForDedup_
// でこれを取り除かないと、同一エラーが連続発生しても dedup キーが毎回変わってしまい
// 重複抑制が効かないため、専用のテストで固定する。
// =============================================================================

test('normalizeMessageForDedup_: tag=FE の場合は "[FE] <clientErrorId> " 接頭辞を取り除く', () => {
  const sandbox = createSandbox();
  const normalized = sandbox.normalizeMessageForDedup_(
    'FE',
    '[FE] a1b2c3d4 Cannot read properties of undefined (reading \'foo\')'
  );
  assert.equal(normalized, 'Cannot read properties of undefined (reading \'foo\')');
});

test('normalizeMessageForDedup_: tag!==FE の場合は message をそのまま返す（既存挙動を変えない）', () => {
  const sandbox = createSandbox();
  const normalized = sandbox.normalizeMessageForDedup_('Invoice', 'BigQuery のクエリでエラーが発生しました');
  assert.equal(normalized, 'BigQuery のクエリでエラーが発生しました');
});

test('notifySlackError_: 非FEタグは従来通り同一tag・同一messageの連続通知が抑制される（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, 'BigQuery のクエリでエラーが発生しました');

  sandbox.notifySlackError_('Invoice', 'BigQuery のクエリでエラーが発生しました', err, {});
  sandbox.notifySlackError_('Invoice', 'BigQuery のクエリでエラーが発生しました', err, {});

  assert.equal(sandbox.__fetchCalls.length, 1, '60秒以内の同一tag・同一messageは2回目がスキップされるべき');
});

test('notifySlackError_: FEタグは clientErrorId が異なっても同一rawMessageなら重複抑制される（本修正の主目的）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const message1 = '[FE] a1b2c3d4 Cannot read properties of undefined (reading \'foo\')';
  const message2 = '[FE] ffffffff Cannot read properties of undefined (reading \'foo\')';
  const err1 = makeSandboxError(sandbox, message1);
  const err2 = makeSandboxError(sandbox, message2);

  sandbox.notifySlackError_('FE', message1, err1, {});
  sandbox.notifySlackError_('FE', message2, err2, {});

  assert.equal(
    sandbox.__fetchCalls.length,
    1,
    'clientErrorIdのみが異なる同一エラーは2回目がスキップされるべき（修正前は毎回別キー扱いで漏れていた）'
  );
});

test('notifySlackError_: FEタグでも rawMessage が異なれば別エラーとして通知される（正規化のしすぎ防止）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const message1 = '[FE] a1b2c3d4 TypeError: foo is not a function';
  const message2 = '[FE] ffffffff ReferenceError: bar is not defined';
  const err1 = makeSandboxError(sandbox, message1);
  const err2 = makeSandboxError(sandbox, message2);

  sandbox.notifySlackError_('FE', message1, err1, {});
  sandbox.notifySlackError_('FE', message2, err2, {});

  assert.equal(sandbox.__fetchCalls.length, 2, 'rawMessageが異なる別エラーは抑制されず、両方通知されるべき');
});

// =============================================================================
// 検証7: Slack特殊記法のエスケープ（reportClientError 経由の FEパス）
//
// reportClientError() が受け取るpayloadはブラウザ側で自由に改ざん可能なため、
// message/stack 等の値に <!channel> や <@U...> のような Slack の
// 特殊記法が含まれていても、Slack投稿時にメンション/リンクとして展開されないよう
// escapeSlackText_() でエスケープしてから Error/context に格納されている必要がある。
// wholesalerId/wholesalerName のエスケープは buildSlackBlocks_ 側で一元化されているため
// （検証9で別途確認）、ここでは message/stack のエスケープを中心に検証する。
// =============================================================================

test('escapeSlackText_: &, <, > をこの順序で正しくエスケープする（&を先に処理しないと二重エスケープする）', () => {
  const sandbox = createSandbox();
  assert.equal(sandbox.escapeSlackText_('<!channel>'), '&lt;!channel&gt;');
  assert.equal(sandbox.escapeSlackText_('<@U12345>'), '&lt;@U12345&gt;');
  assert.equal(sandbox.escapeSlackText_('A & B'), 'A &amp; B');
  assert.equal(sandbox.escapeSlackText_('<'), '&lt;');
  assert.equal(sandbox.escapeSlackText_('>'), '&gt;');
});

test('escapeSlackText_: null/undefined は空文字を返す', () => {
  const sandbox = createSandbox();
  assert.equal(sandbox.escapeSlackText_(null), '');
  assert.equal(sandbox.escapeSlackText_(undefined), '');
});

test('reportClientError: payload.message の <!channel> がエスケープされ、Slack本文に生のメンションとして出力されない', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: '<!channel> 全員へのメンション注入テスト',
    stack: '',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<!channel>/, '生の <!channel> がSlack本文に含まれてはいけない');
  assert.match(text, /&lt;!channel&gt;/, 'エスケープ済みの &lt;!channel&gt; が本文に含まれるべき');
});

test('reportClientError: payload.wholesalerName の <@U...> メンションがエスケープされる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: 'テストエラー',
    wholesalerName: '<@U12345|malicious>',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<@U12345/, '生のユーザーメンション記法がSlack本文に含まれてはいけない');
  assert.match(text, /&lt;@U12345\|malicious&gt;/);
});

test('reportClientError: payload.stack に含まれる特殊記法もエスケープされる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: 'テストエラー',
    stack: 'Error: テストエラー\n    at <!channel> (app.js:1:1)',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<!channel>/);
  assert.match(text, /&lt;!channel&gt;/);
});

test('reportClientError: 特殊記法を含まない通常のペイロードは従来通り正常に通知される（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  const result = sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: 'Cannot read properties of undefined (reading \'foo\')',
    stack: 'TypeError: ...',
    wholesalerId: '123',
    wholesalerName: 'テスト卸',
  }, null);

  assert.equal(result.status, 'success');
  assert.equal(result.data, null);
  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /Cannot read properties of undefined/);
  assert.match(text, /テスト卸/);
});

// =============================================================================
// 検証8: 重複抑制（isDuplicateRecent_ / notifySlackError_）― 正常系（Cacheが正常時）
//
// 検証6のテストは「FE由来messageのclientErrorId正規化」が主目的だったため、
// ここでは「Cacheが正常に動作している場合、レートリミット（60秒以内の同一tag・
// 同一messageの重複抑制）がそもそも意図通り機能する」こと自体を、
// isDuplicateRecent_ の直接呼び出し・notifySlackError_ 経由の両方で明示的に確認する。
// 既存の検証1には「Cache障害時は抑制しない」テストはあったが、Cacheが正常な場合に
// 実際に抑制される（＝レートリミットの本体機能）ことを検証するテストが手薄だったため、
// 本節で isDuplicateRecent_ 単体テストと tag/message の差異による非抑制確認を補強する。
// =============================================================================

test('isDuplicateRecent_: 初回呼び出しは重複なし(false)を返し、Cacheに書き込む（正常系）', () => {
  const sandbox = createSandbox();

  const result = sandbox.isDuplicateRecent_('Invoice', 'BigQuery のクエリでエラーが発生しました');

  assert.equal(result, false, '初回は重複なしのはず');
  assert.equal(sandbox.__cachePutCalls.length, 1, '重複なしと判定した場合はCacheへの書き込みが1回発生するはず');
});

test('isDuplicateRecent_: 同一tag・同一messageを直後に呼ぶと2回目は重複あり(true)を返す（正常系のレートリミット本体）', () => {
  const sandbox = createSandbox();

  const first = sandbox.isDuplicateRecent_('Invoice', 'BigQuery のクエリでエラーが発生しました');
  const second = sandbox.isDuplicateRecent_('Invoice', 'BigQuery のクエリでエラーが発生しました');

  assert.equal(first, false, '1回目は重複なしのはず');
  assert.equal(second, true, '2回目（60秒以内・同一tag・同一message）は重複ありのはず');
  // 2回目はCache.getでヒットして即returnするため、Cacheへの書き込み(put)は1回目の1回のみのはず
  assert.equal(sandbox.__cachePutCalls.length, 1);
});

test('isDuplicateRecent_: messageが異なれば同一tagでも重複と判定しない（誤抑制防止）', () => {
  const sandbox = createSandbox();

  const first = sandbox.isDuplicateRecent_('Invoice', 'BigQuery のクエリでエラーが発生しました');
  const second = sandbox.isDuplicateRecent_('Invoice', 'Drive フォルダの作成に失敗しました');

  assert.equal(first, false);
  assert.equal(second, false, 'messageが異なる場合は別キー扱いとなり、重複抑制されないはず');
  assert.equal(sandbox.__cachePutCalls.length, 2, '別キー扱いのため、それぞれCacheへの書き込みが発生するはず');
});

test('isDuplicateRecent_: tagが異なれば同一messageでも重複と判定しない（誤抑制防止）', () => {
  const sandbox = createSandbox();

  const first = sandbox.isDuplicateRecent_('Invoice', '予期しないエラーが発生しました');
  const second = sandbox.isDuplicateRecent_('Auth', '予期しないエラーが発生しました');

  assert.equal(first, false);
  assert.equal(second, false, 'tagが異なる場合は別キー扱いとなり、重複抑制されないはず');
  assert.equal(sandbox.__cachePutCalls.length, 2, '別キー扱いのため、それぞれCacheへの書き込みが発生するはず');
});

test('notifySlackError_: Cacheが正常な場合、同一tag・同一messageを60秒以内に複数回呼んでもSlack送信(fetch)は1回だけになる（正常系のレートリミット確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, '予期しないエラーが発生しました');

  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {});
  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {});
  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {});

  assert.equal(
    sandbox.__fetchCalls.length,
    1,
    'Cacheが正常に機能していれば、同一tag・同一messageの連続通知は1回目のみSlackへ送信され、以降はレートリミットされるはず'
  );
});

test('notifySlackError_: Cacheが正常な場合でも、messageが異なれば両方Slackへ送信される（レートリミットの誤爆防止）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err1 = makeSandboxError(sandbox, 'BigQuery のクエリでエラーが発生しました');
  const err2 = makeSandboxError(sandbox, 'Drive フォルダの作成に失敗しました');

  sandbox.notifySlackError_('Invoice', 'BigQuery のクエリでエラーが発生しました', err1, {});
  sandbox.notifySlackError_('Invoice', 'Drive フォルダの作成に失敗しました', err2, {});

  assert.equal(sandbox.__fetchCalls.length, 2, 'messageが異なる別エラーはレートリミットされず、両方送信されるべき');
});

// =============================================================================
// 検証9: BE側コンテキスト（ctx.wholesalerId / ctx.wholesalerName）のエスケープ
//
// be_invoice.js・be_auth.js・be_server.js 等の BE 呼び出し元は、BigQuery から取得した
// accountInfo.wholesaler_name を一切エスケープせず、そのまま context.wholesalerName として
// logError_(tag, message, err, context) → notifySlackError_ → buildSlackBlocks_ に渡している。
// 卸名がDB上で任意の文字列になり得る前提に立つと、<!channel> や <@U...> のような
// Slack特殊記法が卸名に含まれた場合、buildSlackBlocks_ 側でエスケープしなければ
// 意図しないメンション/リンク展開（通知荒らし）が起き得る。
// reportClientError（FEパス）は既にpayload側でmessage/stackをエスケープ済みだが、
// wholesalerId/wholesalerNameは「呼び出し元では二重エスケープしない」設計に変更したため、
// ここでは be_invoice.js 等と同様に notifySlackError_ を「BE呼び出し元」として直接叩き、
// 生のcontextからでもエスケープされることを確認する。
// =============================================================================

test('notifySlackError_: BE由来context（DB由来のwholesalerName）に <!channel> が含まれてもエスケープされる（be_invoice.js等のBE呼び出しパターンを模擬）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, 'BigQuery のクエリでエラーが発生しました');

  // be_invoice.js 等の実装同様、wholesalerName は accountInfo.wholesaler_name を
  // 一切加工せず context にそのまま渡す想定（呼び出し元は何もエスケープしない）。
  sandbox.notifySlackError_('Invoice', 'BigQuery のクエリでエラーが発生しました', err, {
    wholesalerId: 123,
    wholesalerName: '<!channel> 悪意ある卸名',
    actionLabel: '請求書登録',
  });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<!channel>/, 'DB由来のwholesalerNameに含まれる生の<!channel>がSlack本文に含まれてはいけない');
  assert.match(text, /&lt;!channel&gt;/, 'エスケープ済みの &lt;!channel&gt; が本文に含まれるべき');
});

test('notifySlackError_: BE由来context の wholesalerName に <@U...> メンションが含まれてもエスケープされる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, '予期しないエラーが発生しました');

  sandbox.notifySlackError_('Auth', '予期しないエラーが発生しました', err, {
    wholesalerId: 456,
    wholesalerName: '<@U99999|なりすまし卸>',
  });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<@U99999/, '生のユーザーメンション記法がSlack本文に含まれてはいけない');
  assert.match(text, /&lt;@U99999\|なりすまし卸&gt;/);
});

test('notifySlackError_: BE由来context の wholesalerId（数値）もエスケープ関数を通しても壊れず正しく表示される', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, 'BigQuery のクエリでエラーが発生しました');

  // wholesalerId は accountInfo.wholesaler_id 由来で通常は数値（文字列化されていない）。
  // escapeSlackText_ に数値をそのまま渡しても例外にならず、想定通りの文字列になることを確認する。
  sandbox.notifySlackError_('Invoice', 'BigQuery のクエリでエラーが発生しました', err, {
    wholesalerId: 789,
    wholesalerName: '通常の卸名株式会社',
  });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /wholesaler_id=789/);
  assert.match(text, /通常の卸名株式会社/);
});

test('reportClientError: wholesalerName のエスケープが二重に行われない（buildSlackBlocks_への一元化後の回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: 'テストエラー',
    wholesalerName: '<@U12345|malicious>',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  // 二重エスケープされていれば "&amp;lt;" のような文字列になるはずだが、
  // buildSlackBlocks_ による一元エスケープ（1回だけ）なのでそれは発生しないはず。
  assert.doesNotMatch(text, /&amp;lt;/, 'wholesalerNameが二重エスケープされてはいけない（&amp;lt; になっていないこと）');
  assert.match(text, /&lt;@U12345\|malicious&gt;/, '1回だけエスケープされた &lt;@U12345\|malicious&gt; が含まれるべき');
});
// =============================================================================
// 検証10: エラー内容（message / err.message / err.stack）のエスケープ
//
// buildSlackBlocks_ は "❗ エラー内容" 行で err.message / err.stack を、"📍 発生箇所" 行で
// message を本文に埋め込む。be_invoice.js の validateCsvHeader_ のように、アップロードされた
// CSVのヘッダーセル値をそのまま Error に埋め込む呼び出しパターンが存在するため、
// err.message/err.stack に <!channel> や <@U...> のような Slack 特殊記法が
// 含まれていても、buildSlackBlocks_ でエスケープしなければ意図しないメンション/リンク展開
// （通知荒らし）が起き得る。
// reportClientError（FEパス）は既に message/stack を呼び出し側でエスケープしていたが、
// buildSlackBlocks_ への一元化に伴い reportClientError 側の事前エスケープは削除済み。
// このセクションでは BE直接呼び出し・FE経由の両方でエスケープされることと、
// 二重エスケープが起きないことの両方を確認する。
// =============================================================================

test('notifySlackError_: BE直接呼び出しで err.message に <!channel> が含まれてもエスケープされる（validateCsvHeader_のようにCSVセル値をそのままErrorに埋め込むパターンを模擬）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  // validateCsvHeader_ の実装同様、アップロードされたCSVのセル値をそのまま Error の message に埋め込む想定。
  const err = makeSandboxError(sandbox, 'CSVの値が不正: 実際="<!channel> 悪意あるCSV値"');

  sandbox.notifySlackError_('Invoice', 'validateCsvHeader_', err, {});

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<!channel>/, '生のerr.messageに含まれる<!channel>がSlack本文に含まれてはいけない');
  assert.match(text, /&lt;!channel&gt;/, 'エスケープ済みの &lt;!channel&gt; がエラー内容に含まれるべき');
});

test('notifySlackError_: BE直接呼び出しで err.stack に特殊記法が含まれてもエスケープされる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, '予期しないエラーが発生しました');
  err.stack = 'Error: 予期しないエラーが発生しました\n    at <@U99999> (be_invoice.js:100:1)';

  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {});

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<@U99999>/, '生のerr.stackに含まれるユーザーメンション記法がSlack本文に含まれてはいけない');
  assert.match(text, /&lt;@U99999&gt;/, 'エスケープ済みの &lt;@U99999&gt; がエラー内容（スタックトレース）に含まれるべき');
});

test('notifySlackError_: "発生箇所" 行に埋め込まれる message もエスケープされる（err.messageとは別の埋め込み箇所）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  // err.message と message 引数をあえて異なる値にし、"発生箇所"行（message使用）が
  // "エラー内容"行（err.message使用）とは独立にエスケープされていることを確認する。
  const err = makeSandboxError(sandbox, '別のerr.message');

  sandbox.notifySlackError_('Invoice', '<!channel> 発生箇所に埋め込まれるmessage', err, {});

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<!channel>/, '発生箇所に埋め込まれるmessage中の<!channel>もエスケープされなければならない');
  assert.match(text, /&lt;!channel&gt; 発生箇所/, '発生箇所行にエスケープ済みのmessageが含まれるべき');
});

test('reportClientError: message/stack のエスケープが二重に行われない（buildSlackBlocks_への一元化後の回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: '<!channel> FEからのエラー',
    stack: 'Error: <@U12345>\n    at foo (app.js:1:1)',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  // 二重エスケープされていれば "&amp;lt;" のような文字列になるはずだが、
  // buildSlackBlocks_ による一元エスケープ（1回だけ）なのでそれは発生しないはず。
  assert.doesNotMatch(text, /&amp;lt;/, 'message/stackが二重エスケープされてはいけない（&amp;lt; になっていないこと）');
  assert.match(text, /&lt;!channel&gt; FEからのエラー/, '発生箇所・エラー内容の両方で1回だけエスケープされたmessageが含まれるべき');
  assert.match(text, /&lt;@U12345&gt;/, 'スタックトレース内の特殊記法も1回だけエスケープされているべき');
});

// =============================================================================
// 検証10-b: buildSlackBlocks_ が「エラー内容」行と「スタックトレース」行で
// 同じメッセージを重複表示しない（実運用のSlack通知で発見された不具合の回帰確認）
//
// GoogleJsonResponseException 等、GAS/V8 のエラーは err.stack の1行目が
// "{ErrorName}: {err.message}" 形式になるため、「エラー内容: {err.message}」の直後に
// 同一文言を含む1行目がそのまま出力され、同じ内容が2回連続表示されてしまう不具合があった。
// =============================================================================

test('notifySlackError_: err.stackの1行目がerr.messageと同じ内容の場合、重複行を除去して実際のスタックフレームのみ表示する（実運用で発見された不具合の回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const longMessage = '次のエラーが発生し、bigquery.jobs.query の呼び出しに失敗しました: Query error: Column slip_number is not present in table usenpay-connect-dev.connect_db.invoice_lines at [104:61]';
  const err = makeSandboxError(sandbox, longMessage);
  // GoogleJsonResponseException 等、実際のGAS例外のスタックトレースを模擬
  // （1行目が "{ErrorName}: {message}" で err.message と同一内容を含む）。
  err.stack = 'GoogleJsonResponseException: ' + longMessage +
    '\n    at runTransactionSql_ (db_bq_connection:142:32)' +
    '\n    at sendInvoiceData (be_invoice:1505:5)';

  sandbox.notifySlackError_('Invoice', longMessage, err, { invoiceUuid: 'test-uuid' });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);

  // longMessage は "発生箇所"（safeMessage）と "エラー内容"（errMessage）の2箇所で
  // 表示されるのが正しい（重複除去の対象はスタックトレース1行目のみ）。
  // それ以上（スタックトレース1行目にも重複して含まれる）出現していないことを確認する。
  const occurrences = text.split(longMessage).length - 1;
  assert.equal(occurrences, 2, 'longMessageは「発生箇所」と「エラー内容」の2箇所にのみ出現し、スタックトレース側で重複表示されてはいけない');

  // 実際のスタックフレーム（at ...）は引き続き表示されること
  assert.match(text, /at runTransactionSql_ \(db_bq_connection:142:32\)/, '実際のスタックフレームは表示され続けるべき');
  assert.match(text, /at sendInvoiceData \(be_invoice:1505:5\)/, '実際のスタックフレームは表示され続けるべき');
  // 重複除去後の1行目（GoogleJsonResponseException: ...）自体は残っていないこと
  assert.doesNotMatch(text, /GoogleJsonResponseException:/, '重複するスタックトレース1行目（ErrorName: message）は除去されるべき');
});

test('notifySlackError_: err.stackがerr.messageと無関係な内容の場合は何も除去せず全行そのまま表示する（FE等の独自stack形式への安全策）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, '予期しないエラーが発生しました');
  // reportClientError のように、err.stack が err.message と無関係な内容で
  // 上書きされているケース（重複判定にマッチしないため除去されないはず）。
  err.stack = 'Error: 別の内容\n    at handler (app.js:10:1)';

  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {});

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /Error: 別の内容/, 'err.messageと無関係なスタック1行目は除去されず残るべき');
  assert.match(text, /at handler \(app\.js:10:1\)/, 'スタックフレームは表示され続けるべき');
});

// =============================================================================
// 検証11: 具体的ID（idPairs: ctx.invoiceUuid / stagingId / storeInvoiceId / parentInvoiceId）のエスケープ
//
// buildSlackBlocks_ の「調査のヒント」欄には、判明している具体的IDを
// `key + ': ' + ctx[key]` の形でSlack mrkdwn本文に直接連結していた。
// これらのIDはDB由来（be_invoice.js 等のBE呼び出し元がBigQueryから取得した
// invoice_uuid・staging_id 等をそのまま渡す）であり、任意の文字列が混入し得るため、
// 他のフィールド同様 escapeSlackText_() を通す必要がある。
// なお、Cloud Logging検索リンク用の searchText は ctx[key] の生値を別途参照して
// URLエンコードするため、この対応による影響を受けないことも合わせて確認する。
// =============================================================================

test('notifySlackError_: idPairs（ctx.invoiceUuid/stagingId等）に <!channel> や <@U...> が含まれてもエスケープされる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, 'BigQuery のクエリでエラーが発生しました');

  sandbox.notifySlackError_('Invoice', 'BigQuery のクエリでエラーが発生しました', err, {
    invoiceUuid: '<!channel>-uuid',
    stagingId: '<@U99999>-staging',
  });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /invoiceUuid=<!channel>/, '生のinvoiceUuidに含まれる<!channel>がSlack本文に含まれてはいけない');
  assert.doesNotMatch(text, /stagingId=<@U99999>/, '生のstagingIdに含まれるメンション記法がSlack本文に含まれてはいけない');
  assert.match(text, /invoiceUuid=&lt;!channel&gt;-uuid/, 'invoiceUuidはエスケープ済みで本文に含まれるべき');
  assert.match(text, /stagingId=&lt;@U99999&gt;-staging/, 'stagingIdはエスケープ済みで本文に含まれるべき');
});

test('notifySlackError_: idPairsのエスケープはCloud Logging検索リンク（searchText）の生成には影響しない', () => {
  const sandbox = createSandbox({
    scriptProperties: {
      SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy',
      GCP_PROJECT_ID: 'test-project',
    },
  });
  const err = makeSandboxError(sandbox, 'BigQuery のクエリでエラーが発生しました');

  sandbox.notifySlackError_('Invoice', 'BigQuery のクエリでエラーが発生しました', err, {
    invoiceUuid: '<uuid-1234>',
  });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  // idPairs表示部分はエスケープされているべき
  assert.match(text, /invoiceUuid=&lt;uuid-1234&gt;/, 'idPairs表示部分はエスケープされているべき');
  // Cloud LoggingリンクのURLは searchText（ctx[key]の生値）をencodeURIComponentしたものが
  // 含まれるべき（idPairs表示用のエスケープとは独立した経路であることの確認）。
  assert.match(text, /%3Cuuid-1234%3E/, 'Cloud LoggingリンクのURLにはsearchTextの生値がURLエンコードされて含まれるべき');
});

test('notifySlackError_: idPairs対象外のctx値（未知のキー）はそもそも本文に含まれない（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, '予期しないエラーが発生しました');

  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {
    invoiceUuid: 'uuid-abc',
    someUnknownKey: '<!channel> 無関係な値',
  });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /invoiceUuid=uuid-abc/);
  assert.doesNotMatch(text, /someUnknownKey/, 'SLACK_CONTEXT_ID_KEYS_に含まれないキーは本文に出力されないはず');
});

// =============================================================================
// 検証12: ctx.actionLabel のエスケープ
//
// buildSlackBlocks_ は ctx.actionLabel（省略時は tag）を `what` としてタイトル行・
// 「操作」行の両方にそのまま埋め込んでいた。actionLabel は現状すべてのBE呼び出し元で
// 固定の日本語文言だが、他フィールドと同じ方針でエスケープしておくことで、将来
// 外部入力由来の値が渡された場合の mrkdwn 注入余地をなくす。
// =============================================================================

test('notifySlackError_: ctx.actionLabel に <!channel> が含まれてもエスケープされる（将来的な保険）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, '予期しないエラーが発生しました');

  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {
    actionLabel: '<!channel> 悪意ある操作名',
  });

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /<!channel>/, '生のactionLabelに含まれる<!channel>がSlack本文（タイトル・操作行）に含まれてはいけない');
  assert.match(text, /&lt;!channel&gt; 悪意ある操作名に失敗/, 'タイトル行でもエスケープ済みのactionLabelが使われるべき');
  assert.match(text, /\*操作:\*\n&lt;!channel&gt; 悪意ある操作名/, '操作フィールドでもエスケープ済みのactionLabelが使われるべき');
});

test('notifySlackError_: ctx.actionLabel 省略時はtagがそのまま操作行に使われる（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, '予期しないエラーが発生しました');

  sandbox.notifySlackError_('Invoice', '予期しないエラーが発生しました', err, {});

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /\*操作:\*\nInvoice/, 'actionLabel省略時はtagがそのまま操作フィールドに使われるべき');
});

test('reportClientError: actionLabel（固定文言「フロントエンドエラー」）が正しく表示される（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({ clientErrorId: 'abcd1234', message: 'テストエラー' }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /\*操作:\*\nフロントエンドエラー/, 'reportClientErrorが設定する固定のactionLabelがエスケープを経ても壊れず表示されるべき');
});

// =============================================================================
// 検証13: notifySlackError_ の判定順序（Webhook設定確認 → 重複抑制判定）
//
// 変更前は「重複抑制判定（Cache書き込みを伴うisDuplicateRecent_）」→「Webhook設定確認」
// の順で処理していたため、SLACK_WEBHOOK_URL 未設定環境でもCacheキーが消費されてしまい、
// 後からWebhookを設定した直後の本来送るべき最初の通知が、TTL(60秒)以内という理由だけで
// 誤って抑制され得た。Webhook確認を重複抑制判定より先に行うことで、
// 「送信できないケース」ではCacheへ一切書き込まないことを保証する。
// =============================================================================

test('notifySlackError_: SLACK_WEBHOOK_URL 未設定時はCacheへの書き込み（重複抑制判定）自体が行われない', () => {
  const sandbox = createSandbox({ scriptProperties: {} });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});

  assert.equal(sandbox.__fetchCalls.length, 0);
  assert.equal(
    sandbox.__cachePutCalls.length,
    0,
    'Webhook未設定時はisDuplicateRecent_（Cache書き込み）自体が実行されてはいけない'
  );
});

test('notifySlackError_: Webhookを未設定→設定に切り替えた直後は、その前の未設定期間中にCacheが汚れていないため誤って抑制されない', () => {
  const sandbox = createSandbox({ scriptProperties: {} });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  // Webhook未設定の状態で複数回連続通知を試みる。
  // 変更前の実装では、ここで重複抑制のCacheキーが消費されてしまっていた。
  sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});
  sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});
  assert.equal(sandbox.__fetchCalls.length, 0);
  assert.equal(sandbox.__cachePutCalls.length, 0);

  // 運用者が直後にWebhookを設定した状況を模擬する（PropertiesServiceの参照先を直接更新）。
  sandbox.__scriptProps.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/dummy';

  sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});

  assert.equal(
    sandbox.__fetchCalls.length,
    1,
    'Webhook設定直後の最初の通知は、未設定期間中にCacheキーが消費されていなければ正しく送信されるはず'
  );
});

test('notifySlackError_: Webhook設定済みの場合の判定順序は従来通り（重複抑制は引き続き機能する・回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const err = makeSandboxError(sandbox, 'システムエラーが発生しました');

  sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});
  sandbox.notifySlackError_('Invoice', 'システムエラーが発生しました', err, {});

  assert.equal(sandbox.__fetchCalls.length, 1, 'Webhook設定済みであれば、順序変更後も重複抑制は従来通り機能するはず');
  assert.equal(sandbox.__cachePutCalls.length, 1, 'Webhook設定済みであれば、1回目の呼び出しでCacheへの書き込みが発生するはず');
});

// =============================================================================
// 検証14: reportClientError の wholesalerId/wholesalerName 長さ上限
//
// reportClientError は message/stack/url/ua をそれぞれ 500/2000/300/300文字で
// 切り詰めていたが、wholesalerId/wholesalerName にはこれまで長さ上限がなかった。
// これらは payload 同様ブラウザ側で自由に書き換え・送信できる値のため、極端に長い
// 文字列を送られると Slack Webhook 送信ペイロードが肥大化し、送信遅延・失敗を招き得る。
// 他フィールドと同じ方針で、値がある場合のみ100文字に切り詰めることを確認する。
// =============================================================================

test('reportClientError: wholesalerId が長すぎる場合は100文字に切り詰められる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const longWholesalerId = '1'.repeat(1000);

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: 'テストエラー',
    wholesalerId: longWholesalerId,
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, new RegExp('1'.repeat(101)), '1000文字のwholesalerIdがそのまま本文に含まれてはいけない');
  assert.match(text, new RegExp('`wholesaler_id=' + '1'.repeat(100) + '(?!1)'), 'wholesalerIdは100文字に切り詰められて本文に含まれるべき');
});

test('reportClientError: wholesalerName が長すぎる場合は100文字に切り詰められる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const longWholesalerName = 'あ'.repeat(1000);

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: 'テストエラー',
    wholesalerName: longWholesalerName,
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, new RegExp('あ'.repeat(101)), '1000文字のwholesalerNameがそのまま本文に含まれてはいけない');
  assert.match(text, new RegExp('あ'.repeat(100) + '(?!あ)'), 'wholesalerNameは100文字に切り詰められて本文に含まれるべき');
});

test('reportClientError: wholesalerId/wholesalerName が未送信（falsy）の場合はnullのまま維持され「不明」表示になる（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({ clientErrorId: 'abcd1234', message: 'テストエラー' }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /\*対象卸:\*\n-/, 'wholesalerId/wholesalerName未送信時は「-」表示になるべき（BOシステムのフォーマットに合わせた仕様変更）');
});

test('reportClientError: wholesalerId/wholesalerName が100文字以下の場合は切り詰められず従来通り表示される（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'abcd1234',
    message: 'テストエラー',
    wholesalerId: '789',
    wholesalerName: '通常の卸名株式会社',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /wholesaler_id=789/);
  assert.match(text, /通常の卸名株式会社/);
});

// =============================================================================
// 検証15: reportClientError の payload.clientErrorId 検証（不正値のサーバ側フォールバック）
//
// payload.clientErrorId はブラウザ側で自由に書き換え可能な入力のため、
// normalizeMessageForDedup_() が前提とする「空白を含まない」（\S+）という制約から
// 外れた値（空白混入・Slack特殊記法・過剰な長さ等）を送られると、"[FE] <clientErrorId> "
// 接頭辞の除去が正しく行われず、同一エラーでも呼び出しごとに異なる重複抑制キーになって
// しまう（＝重複抑制を容易に回避され、Slack通知スパムを誘発し得る）。
// CLIENT_ERROR_ID_PATTERN_（英数字・ハイフン・アンダースコアのみ、1〜32文字）に
// 一致しない値は、reportClientError() 内でサーバ側生成の8桁hex IDに差し替えられる。
// なお、テスト環境の Utilities.getUuid() モックは常に固定値
// '00000000-0000-0000-0000-000000000000' を返すため、フォールバック後のIDは
// 常に '00000000' になる（本テストではこれを利用し、フォールバックの発生自体と、
// フォールバック後は正しく重複抑制が機能することの両方を確認する）。
// =============================================================================

test('reportClientError: clientErrorIdに空白が含まれる場合、生の値は使われずサーバ側生成IDに差し替えられる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'evil id',
    message: 'テストエラー',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /evil id/, '空白を含む不正なclientErrorIdがそのまま本文に使われてはいけない');
  assert.match(text, /\[FE\] 00000000 /, 'サーバ側生成ID（テスト環境では固定値00000000）に差し替えられるべき');
});

test('reportClientError: 空白混入の不正なclientErrorIdを使ってもSlack通知スパム（重複抑制回避）は成立しない（本修正の主目的）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  // 攻撃者が毎回異なる空白混入clientErrorIdを送り、重複抑制キーをずらそうとするケースを模擬する。
  // 修正前は \S+ 前提が崩れて正規化に失敗し、3回とも別キー扱いでSlackへ送信されてしまっていた。
  sandbox.reportClientError({ clientErrorId: 'evil id 1', message: '同一エラー本文' }, null);
  sandbox.reportClientError({ clientErrorId: 'evil id 2222', message: '同一エラー本文' }, null);
  sandbox.reportClientError({ clientErrorId: 'totally different spammy id here', message: '同一エラー本文' }, null);

  assert.equal(
    sandbox.__fetchCalls.length,
    1,
    '不正なclientErrorIdはサーバ側生成IDに差し替えられ正しく正規化されるため、同一エラーの連続通知はレートリミットされ1回のみ送信されるはず'
  );
});

test('reportClientError: clientErrorIdにSlack特殊記法など空白以外の禁止文字が含まれる場合もサーバ側生成IDに差し替えられる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: '<!channel>',
    message: 'テストエラー',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, /channel/i, '許可文字（英数字・ハイフン・アンダースコア）以外を含む不正なclientErrorIdが使われてはいけない');
  assert.match(text, /\[FE\] 00000000 /, 'サーバ側生成IDに差し替えられるべき');
});

test('reportClientError: clientErrorIdが32文字を超える場合もサーバ側生成IDに差し替えられる', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });
  const tooLongId = 'a'.repeat(40);

  sandbox.reportClientError({
    clientErrorId: tooLongId,
    message: 'テストエラー',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.doesNotMatch(text, new RegExp('a'.repeat(33)), '32文字を超える不正なclientErrorIdがそのまま使われてはいけない');
  assert.match(text, /\[FE\] 00000000 /, 'サーバ側生成IDに差し替えられるべき');
});

test('reportClientError: 有効な形式（英数字のみ・32文字以下）のclientErrorIdはそのまま使われる（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({
    clientErrorId: 'a1b2c3d4',
    message: 'テストエラー',
  }, null);

  assert.equal(sandbox.__fetchCalls.length, 1);
  const sentPayload = JSON.parse(sandbox.__fetchCalls[0].params.payload);
  const text = allBlocksText(sentPayload);
  assert.match(text, /\[FE\] a1b2c3d4 /, '有効なclientErrorIdはそのまま本文に使われるべき（サーバ側IDに差し替えられない）');
});

test('reportClientError: clientErrorId が空文字・未指定の場合は従来通りサーバ側生成IDにフォールバックする（回帰確認）', () => {
  const sandbox = createSandbox({
    scriptProperties: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/dummy' },
  });

  sandbox.reportClientError({ clientErrorId: '', message: 'エラーA' }, null);
  sandbox.reportClientError({ message: 'エラーB' }, null); // clientErrorId未指定

  assert.equal(sandbox.__fetchCalls.length, 2, 'messageが異なるため両方送信されるはず');
  const text1 = allBlocksText(JSON.parse(sandbox.__fetchCalls[0].params.payload));
  const text2 = allBlocksText(JSON.parse(sandbox.__fetchCalls[1].params.payload));
  assert.match(text1, /\[FE\] 00000000 /, '空文字のclientErrorIdはサーバ側生成IDにフォールバックするべき（従来通り）');
  assert.match(text2, /\[FE\] 00000000 /, 'clientErrorId未指定時もサーバ側生成IDにフォールバックするべき（従来通り）');
});