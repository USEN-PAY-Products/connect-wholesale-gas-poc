const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAuthz(email, cfg) {
  const sandbox = {
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    getConfig_: () => Object.assign({ allowedDomains: [], allowedEmails: [] }, cfg),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/be_authz.js'), 'utf8'), sandbox);
  return sandbox;
}

test('requireAuthorizedOperator_: 許可リスト未設定なら全員許可', () => {
  assert.equal(loadAuthz('a@example.com', {}).requireAuthorizedOperator_(), 'a@example.com');
});

test('requireAuthorizedOperator_: ドメインのみ設定（一致は許可・不一致は拒否）', () => {
  const cfg = { allowedDomains: ['example.com'] };
  assert.equal(loadAuthz('a@Example.com', cfg).requireAuthorizedOperator_(), 'a@Example.com');
  assert.throws(() => loadAuthz('a@other.com', cfg).requireAuthorizedOperator_(), /^Error: FORBIDDEN:/);
});

test('requireAuthorizedOperator_: メールのみ設定（一致は許可・不一致は拒否）', () => {
  const cfg = { allowedEmails: ['a@example.com'] };
  assert.equal(loadAuthz('a@example.com', cfg).requireAuthorizedOperator_(), 'a@example.com');
  assert.throws(() => loadAuthz('b@example.com', cfg).requireAuthorizedOperator_(), /^Error: FORBIDDEN:/);
});

test('requireAuthorizedOperator_: 両方設定した場合は両条件を満たす必要がある', () => {
  const cfg = { allowedDomains: ['example.com'], allowedEmails: ['a@example.com'] };
  assert.equal(loadAuthz('a@example.com', cfg).requireAuthorizedOperator_(), 'a@example.com');
  assert.throws(() => loadAuthz('b@example.com', cfg).requireAuthorizedOperator_(), /^Error: FORBIDDEN:/);
});

test('requireAuthorizedOperator_: メールが空・取得失敗は UNAUTHORIZED', () => {
  assert.throws(() => loadAuthz('', {}).requireAuthorizedOperator_(), /^Error: UNAUTHORIZED:/);
  const s = loadAuthz('x@example.com', {});
  s.Session.getActiveUser = () => { throw new Error('x'); };
  assert.throws(() => s.requireAuthorizedOperator_(), /^Error: UNAUTHORIZED:/);
});
