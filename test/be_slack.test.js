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
// 検証7: Slack特殊記法のエスケープ（reportClientError）
//
// reportClientError() が受け取る payload はブラウザ側で自由に改ざん可能なため、
// message/stack/wholesalerName 等の値に <!channel> や <@U...> のような Slack の
// 特殊記法が含まれていても、Slack投稿時にメンション/リンクとして展開されないよう
// escapeSlackText_() でエスケープしてから Error/context に格納されている必要がある。
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
  const text = sentPayload.blocks[0].text.text;
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
  const text = sentPayload.blocks[0].text.text;
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
  const text = sentPayload.blocks[0].text.text;
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
  const text = sentPayload.blocks[0].text.text;
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
