'use strict';
const BOOL = new Set(['--help','-h','--version','-v','--wizard','--print-logs','--standalone','--auto','--continue','-c']);
const VALUE = new Set(['--log-level','--completions','--server','--session','-s','--prompt']);
const LITERALS = new Set(['true','yes','on','1','y','false','no','off','0','n']);
const TARGET = new Set(['update','upgrade','uninstall']);
function withAutoUpdateEnv(env) {
  const result = { ...env };
  if (result.OPENCODE_DISABLE_AUTOUPDATE === undefined) result.OPENCODE_DISABLE_AUTOUPDATE = '1';
  return result;
}
function route(argv) {
  let unknown = false, help = false, unconsumedTargets = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') break;
    if (t === '--help' || t === '-h' || t.startsWith('--help=')) help = true;
    if (TARGET.has(t)) unconsumedTargets = true;
    if (t === 'uninstall') return { kind: unknown ? 'refuse' : 'uninstall', rest: [] };
    if (t === 'update' || t === 'upgrade') return { kind: unknown ? 'refuse' : (help ? 'help' : 'update'), rest: argv.slice(i + 1) };
    if (t !== '-' && t.startsWith('-')) {
      const eq = t.indexOf('='), name = eq < 0 ? t : t.slice(0, eq);
      if (eq >= 0 && !t.startsWith('--')) { unknown = true; continue; }
      if (BOOL.has(name)) { if (eq < 0 && LITERALS.has(argv[i + 1])) i++; }
      else if (VALUE.has(name)) { if (eq < 0 && argv[i + 1] !== undefined && (argv[i + 1] === '-' || !argv[i + 1].startsWith('-'))) i++; }
      else unknown = true;
      continue;
    }
    if (unknown) { if (TARGET.has(t)) return { kind: 'refuse', rest: [] }; continue; }
    return { kind: 'passthrough', rest: [] };
  }
  // Consider only unconsumed tokens for ambiguous target subcommands.
  if (unknown && unconsumedTargets) return { kind: 'refuse', rest: [] };
  return { kind: 'passthrough', rest: [] };
}
module.exports = { route, withAutoUpdateEnv };
