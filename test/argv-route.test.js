'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { route, withAutoUpdateEnv } = require('../lib/argv-route');

test('only a first-position management command is routed to the wrapper', () => {
  for (const args of [['update'], ['update', '2.1.0'], ['upgrade', '-h']]) {
    assert.deepEqual(route(args), { kind: 'update', rest: args.slice(1) });
  }
  for (const args of [['uninstall'], ['uninstall', '--anything']]) {
    assert.deepEqual(route(args), { kind: 'uninstall', rest: [] });
  }
  for (const args of [[], ['--help'], ['--version', 'update'], ['--version=true', 'update'],
    ['--version=false', 'update'], ['--completions', 'bash', 'upgrade'],
    ['--completions=bash', 'upgrade'], ['--no-print-logs', 'plugin', 'update', '--help'],
    ['--no-print-logs=true', 'update'], ['--no-print-logs=false', 'update'], ['--print-logs', 'plugin', 'update'],
    ['--print-logs', 'run', 'uninstall'], ['run', 'update', 'the docs'], ['--', 'update']]) {
    assert.deepEqual(route(args), { kind: 'passthrough', rest: [] }, args.join(' '));
  }
});

test('automatic update env is added only when unset', () => {
  assert.equal(withAutoUpdateEnv({}).OPENCODE_DISABLE_AUTOUPDATE, '1');
  for (const value of ['0', 'false', '']) {
    assert.equal(withAutoUpdateEnv({ OPENCODE_DISABLE_AUTOUPDATE: value }).OPENCODE_DISABLE_AUTOUPDATE, value);
  }
  const env = { PATH: '/bin', OPENCODE_DISABLE_AUTOUPDATE: 'false', LD_PRELOAD: '', LD_LIBRARY_PATH: '/glibc' };
  assert.deepEqual(withAutoUpdateEnv(env), env);
});
