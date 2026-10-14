const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(opts) {
  const o = opts || {};
  const calls = { fetch: [], logs: [] };
  const sandbox = {
    requireAuthorizedOperator_: () => {
      if (o.authError) throw new Error(o.authError);
      return 'op@example.com';
    },
    fetchAccountInfoByWholesalerId_: (id, email) => {
      calls.fetch.push([id, email]);
      if (o.fetchError) throw new Error(o.fetchError);
      return o.account === undefined ? { wholesaler_id: id, wholesaler_user_id: 'u1' } : o.account;
    },
    logInfo_: (d, m) => calls.logs.push(m),
    logError_: () => {},
    success_: (data) => ({ status: 'success', data }),
    Session: { getActiveUser: () => ({ getEmail: () => 'op@example.com' }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/be_server.js'), 'utf8'), sandbox);
  sandbox.__calls = calls;
  return sandbox;
}

test('getServerAccountInfo_: 認可エラーは卸検索に進まない', () => {
  const s = load({ authError: 'FORBIDDEN: x' });
  assert.throws(() => s.getServerAccountInfo_('1'), /^Error: FORBIDDEN:/);
  assert.equal(s.__calls.fetch.length, 0);
});

test('getServerAccountInfo_: ID未指定は WHOLESALER_MISSING', () => {
  for (const v of [undefined, null, '', '  ']) {
    const s = load();
    assert.throws(() => s.getServerAccountInfo_(v), /^Error: WHOLESALER_MISSING:/);
    assert.equal(s.__calls.fetch.length, 0);
  }
});

test('getServerAccountInfo_: 形式不正は WHOLESALER_INVALID（BQを呼ばない）', () => {
  for (const v of ['abc', '-1', '1.5', '1 OR 1=1', '1234567890123456']) {
    const s = load();
    assert.throws(() => s.getServerAccountInfo_(v), /^Error: WHOLESALER_INVALID:/);
    assert.equal(s.__calls.fetch.length, 0);
  }
});

test('getServerAccountInfo_: 存在しない卸は WHOLESALER_INVALID', () => {
  const s = load({ account: null });
  assert.throws(() => s.getServerAccountInfo_('9'), /^Error: WHOLESALER_INVALID:/);
});

test('getServerAccountInfo_: inactive の例外はそのまま伝播する', () => {
  const s = load({ fetchError: 'WHOLESALER_INACTIVE: x' });
  assert.throws(() => s.getServerAccountInfo_('1'), /^Error: WHOLESALER_INACTIVE:/);
});

test('getServerAccountInfo_: 成功時は数値IDで検索し operator_email を付与する', () => {
  const s = load();
  const info = s.getServerAccountInfo_('0007');
  assert.deepEqual(s.__calls.fetch[0], [7, 'op@example.com']);
  assert.equal(info.operator_email, 'op@example.com');
});

test('getAccountInfo: 認証・指定系エラーはそのまま、想定外エラーは汎用メッセージに丸める', () => {
  assert.throws(() => load({ authError: 'UNAUTHORIZED: x' }).getAccountInfo('1'), /^Error: UNAUTHORIZED:/);
  assert.throws(() => load({ fetchError: 'boom: secret' }).getAccountInfo('1'), /アカウント情報の取得に失敗しました/);
  assert.equal(load().getAccountInfo('1').status, 'success');
});
