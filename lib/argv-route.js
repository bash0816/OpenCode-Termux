'use strict';
function withAutoUpdateEnv(env) {
  const result = { ...env };
  if (result.OPENCODE_DISABLE_AUTOUPDATE === undefined) result.OPENCODE_DISABLE_AUTOUPDATE = '1';
  return result;
}
function route(argv) {
  const first = argv[0];
  if (first === 'update' || first === 'upgrade') return { kind: 'update', rest: argv.slice(1) };
  if (first === 'uninstall') return { kind: 'uninstall', rest: [] };
  return { kind: 'passthrough', rest: [] };
}
module.exports = { route, withAutoUpdateEnv };
