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
// 検証する5つの安全性（詳細は設計書 §10 参照）:
//   1. notifySlackError_ が異常入力（context省略・fetch例外）でも例外を外に投げない
//   2. SLACK_WEBHOOK_URL 未設定時は例外なくスキップする
//   3. shouldNotifySlack_ が既知の業務エラー文言で false、それ以外で true を返す
//   4. logError_ が、notifySlackError_ が例外を投げても自身は例外を投げない
//   5. PropertiesService 読み取りが getConfig_ を経由していない
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
 * @returns {vm.Context & { __fetchCalls: Array, __loggerLines: Array<string>, __scriptProps: Object }}
 */
function createSandbox(options) {
  const opts = options || {};
  const scriptProps = Object.assign({}, opts.scriptProperties);
  const cacheStore = {};
  const fetchCalls = [];
  const loggerLines = [];

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
          put: function (key, value) {
            if (opts.cacheThrows) throw new Error('CacheService.put は失敗しました（テスト用の疑似障害）');
            cacheStore[key] = value;
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
