'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db_bq_connection.js'),
  'utf8'
);

function createSandbox() {
  const queryCalls = [];
  const sandbox = {
    Logger: { log: function () {} },
    Utilities: { sleep: function () {} },
    getConfig_: function () { return { bqLocation: 'asia-northeast1' }; },
    BigQuery: {
      Jobs: {
        query: function (request, projectId) {
          queryCalls.push({ request: request, projectId: projectId });
          return { jobComplete: true, jobReference: { jobId: 'test-job' } };
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'db_bq_connection.js' });
  sandbox.__queryCalls = queryCalls;
  return sandbox;
}

test('runTransactionSql_: 名前付きクエリパラメータを BigQuery Jobs.query に渡す', () => {
  const sandbox = createSandbox();
  const params = [
    {
      name: 'final_updated_by',
      parameterType: { type: 'STRING' },
      parameterValue: { value: 'operator-user-id' },
    },
  ];

  sandbox.runTransactionSql_('test-project', 'BEGIN TRANSACTION; COMMIT;', params);

  assert.equal(sandbox.__queryCalls.length, 1);
  const call = sandbox.__queryCalls[0];
  assert.equal(call.projectId, 'test-project');
  assert.equal(call.request.parameterMode, 'NAMED');
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.queryParameters)), params);
  assert.equal(call.request.location, 'asia-northeast1');
});

test('runTransactionSql_: パラメータ未指定時は NAMED モードを付けない', () => {
  const sandbox = createSandbox();

  sandbox.runTransactionSql_('test-project', 'BEGIN TRANSACTION; COMMIT;');

  const request = sandbox.__queryCalls[0].request;
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'parameterMode'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'queryParameters'), false);
});
