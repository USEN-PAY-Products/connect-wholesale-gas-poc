'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db_bq_query.js'),
  'utf8'
);
const FE_COMMON_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'fe_js_common.html'),
  'utf8'
);
const CONFIG_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'be_config.js'),
  'utf8'
);

function createSandbox(rows) {
  const queryCalls = [];
  const sandbox = {
    getConfig_: function () {
      return { gcpProjectId: 'test-project', bqDatasetId: 'test_dataset', bqLocation: 'asia-northeast1' };
    },
    logInfo_: function () {},
    BigQuery: {
      Jobs: {
        query: function (request, projectId) {
          queryCalls.push({ projectId: projectId, request: request });
          const fields = rows.length > 0
            ? Object.keys(rows[0]).map(function (name) { return { name: name }; })
            : [{ name: 'wholesaler_id' }, { name: 'wholesaler_name' }];
          return {
            jobComplete: true,
            jobReference: { jobId: 'test-job' },
            schema: { fields: fields },
            rows: rows.map(function (row) {
              return { f: fields.map(function (field) { return { v: row[field.name] }; }) };
            }),
          };
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'db_bq_query.js' });
  sandbox.__queryCalls = queryCalls;
  return sandbox;
}

test('fetchWholesalerNameById_: 卸IDをパラメータ化して卸名を取得する', () => {
  const sandbox = createSandbox([{ wholesaler_id: '789', wholesaler_name: '正規の卸名' }]);

  const result = sandbox.fetchWholesalerNameById_('789');

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    wholesaler_id: 789,
    wholesaler_name: '正規の卸名',
  });
  assert.equal(sandbox.__queryCalls.length, 1);
  const call = sandbox.__queryCalls[0];
  assert.equal(call.projectId, 'test-project');
  assert.match(call.request.query, /FROM `test-project\.test_dataset\.wholesalers`/);
  assert.match(call.request.query, /WHERE id = @wholesaler_id/);
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.queryParameters)), [{
    name: 'wholesaler_id',
    parameterType: { type: 'INT64' },
    parameterValue: { value: '789' },
  }]);
});

test('fetchWholesalerNameById_: 該当する卸がない場合はnullを返す', () => {
  const sandbox = createSandbox([]);

  assert.equal(sandbox.fetchWholesalerNameById_('789'), null);
});

test('switchWholesaler_: 選択した卸IDでTOP画面を開く', () => {
  const switchFunction = FE_COMMON_SOURCE.match(/function switchWholesaler_\([\s\S]*?\n\}/);
  assert.ok(switchFunction, 'switchWholesaler_ should exist');

  const sandbox = {
    window: {
      __WEB_APP_URL__: 'https://script.google.com/macros/s/test-deployment/exec',
      top: { location: { href: '' } },
    },
    getWholesalerId_: function () { return ''; },
    clearWholesalerContext_: function () {},
    showToast: function () {},
  };
  vm.createContext(sandbox);
  vm.runInContext(switchFunction[0], sandbox, { filename: 'fe_js_common.html' });
  vm.runInContext("switchWholesaler_('42')", sandbox);

  assert.equal(
    sandbox.window.top.location.href,
    'https://script.google.com/macros/s/test-deployment/exec?wholesalerId=42#home'
  );
});

test('getConfig_: development で WEB_APP_URL 未設定なら local GAS URL を返す', () => {
  const properties = {
    DRIVE_ROOT_FOLDER_ID: 'folder',
    GCP_PROJECT_ID: 'usenpay-connect-dev',
    BQ_DATASET_ID: 'connect_db',
    ENV: 'development',
  };
  const sandbox = {
    PropertiesService: {
      getScriptProperties: function () {
        return { getProperty: function (key) { return properties[key] || ''; } };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CONFIG_SOURCE, sandbox, { filename: 'be_config.js' });

  const config = JSON.parse(vm.runInContext('JSON.stringify(getConfig_())', sandbox));
  assert.equal(
    config.webAppUrl,
    'https://script.google.com/a/macros/unext-hd.jp/s/AKfycbyjIJwPzy1esRyPWEUmWFrThvyF4l7SbZIp_kVKlPdpeFYySbvqcOHBxGMpjrLhVVfc/exec'
  );
});
