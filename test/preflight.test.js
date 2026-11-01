'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  TERMUX_USR,
  TERMUX_PKG,
  SOURCES_LIST,
  PM_SCRIPT,
  GLIBC_LD_PATH,
  PROBLEMS,
  makeProblem,
  PrereqError,
  classifyPatchelfFailure,
  checkPrerequisites,
  buildAutoFix,
} = require('../lib/preflight');

// 定数の値
test('constants have the expected Termux paths', () => {
  assert.equal(TERMUX_USR, '/data/data/com.termux/files/usr');
  assert.equal(TERMUX_PKG, '/data/data/com.termux/files/usr/bin/pkg');
  assert.equal(SOURCES_LIST, '/data/data/com.termux/files/usr/etc/apt/sources.list');
  assert.equal(PM_SCRIPT, '/data/data/com.termux/files/usr/bin/termux-setup-package-manager');
  assert.equal(GLIBC_LD_PATH, '/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1');
});

test('GLIBC_LD_PATH matches the value used by patcher', () => {
  const patcher = require('../lib/patcher');
  assert.equal(patcher.GLIBC_LD_PATH, GLIBC_LD_PATH);
});

// PROBLEMS の固定値
test('PROBLEMS has exactly the 10 problem codes', () => {
  assert.deepEqual(Object.keys(PROBLEMS).sort(), [
    'glibc-broken',
    'glibc-missing',
    'patchelf-failed',
    'patchelf-libcxx-mismatch',
    'patchelf-link-error',
    'patchelf-missing',
    'readelf-failed',
    'readelf-missing',
    'tar-failed',
    'tar-missing',
  ]);
});

test('PROBLEMS fixed values match the table', () => {
  const expected = {
    'glibc-missing': { auto: true, pkgs: ['glibc'], repoPkgs: ['glibc-repo'], commands: ['pkg install glibc-repo && pkg install glibc'] },
    'glibc-broken': { auto: false, pkgs: [], repoPkgs: [], commands: ['pkg install glibc-repo && pkg install glibc'] },
    'patchelf-missing': { auto: true, pkgs: ['patchelf', 'libc++'], repoPkgs: [], commands: ['pkg install patchelf libc++'] },
    'patchelf-libcxx-mismatch': { auto: true, pkgs: ['libc++'], repoPkgs: [], commands: ['pkg install libc++'] },
    'patchelf-link-error': { auto: false, pkgs: [], repoPkgs: [], commands: ['pkg update && pkg upgrade'] },
    'patchelf-failed': { auto: false, pkgs: [], repoPkgs: [], commands: ['pkg install patchelf libc++'] },
    'readelf-missing': { auto: true, pkgs: ['llvm'], repoPkgs: [], commands: ['pkg install llvm'] },
    'readelf-failed': { auto: false, pkgs: [], repoPkgs: [], commands: ['pkg install llvm'] },
    'tar-missing': { auto: true, pkgs: ['tar'], repoPkgs: [], commands: ['pkg install tar'] },
    'tar-failed': { auto: false, pkgs: [], repoPkgs: [], commands: ['pkg install tar'] },
  };
  for (const [code, want] of Object.entries(expected)) {
    const p = PROBLEMS[code];
    assert.ok(p, `missing code: ${code}`);
    assert.equal(p.auto, want.auto, `auto: ${code}`);
    assert.deepEqual(p.pkgs, want.pkgs, `pkgs: ${code}`);
    assert.deepEqual(p.repoPkgs, want.repoPkgs, `repoPkgs: ${code}`);
    assert.deepEqual(p.commands, want.commands, `commands: ${code}`);
  }
});

test('PROBLEMS ja/en texts are non-empty strings', () => {
  for (const [code, p] of Object.entries(PROBLEMS)) {
    assert.equal(typeof p.ja, 'string', `ja type: ${code}`);
    assert.equal(typeof p.en, 'string', `en type: ${code}`);
    assert.ok(p.ja.length > 0, `ja empty: ${code}`);
    assert.ok(p.en.length > 0, `en empty: ${code}`);
  }
});

test('patchelf-link-error texts state that all packages are updated', () => {
  assert.ok(PROBLEMS['patchelf-link-error'].ja.includes('全パッケージ'));
  assert.ok(PROBLEMS['patchelf-link-error'].en.includes('ALL installed packages'));
});

// classifyPatchelfFailure: 各規則
test('ENOENT maps to patchelf-missing', () => {
  assert.equal(classifyPatchelfFailure({ code: 'ENOENT' }), 'patchelf-missing');
});

test('EACCES maps to patchelf-failed', () => {
  assert.equal(classifyPatchelfFailure({ code: 'EACCES' }), 'patchelf-failed');
});

test('ETIMEDOUT maps to patchelf-failed', () => {
  assert.equal(classifyPatchelfFailure({ code: 'ETIMEDOUT' }), 'patchelf-failed');
});

test('signal set maps to patchelf-failed', () => {
  assert.equal(classifyPatchelfFailure({ signal: 'SIGKILL' }), 'patchelf-failed');
});

test('cannot locate symbol with _ZNSt6__ndk1 maps to patchelf-libcxx-mismatch', () => {
  const stderr = 'CANNOT LINK EXECUTABLE: cannot locate symbol "_ZNSt6__ndk112basic_stringE"';
  assert.equal(classifyPatchelfFailure({ stderr }), 'patchelf-libcxx-mismatch');
});

test('CANNOT LINK EXECUTABLE maps to patchelf-link-error', () => {
  assert.equal(
    classifyPatchelfFailure({ stderr: 'CANNOT LINK EXECUTABLE "patchelf": library not found' }),
    'patchelf-link-error',
  );
});

test('cannot locate symbol without _ZNSt6__ndk1 maps to patchelf-link-error', () => {
  assert.equal(
    classifyPatchelfFailure({ stderr: 'cannot locate symbol "foo"' }),
    'patchelf-link-error',
  );
});

test('library "x" not found maps to patchelf-link-error', () => {
  assert.equal(
    classifyPatchelfFailure({ stderr: 'library "libfoo.so" not found' }),
    'patchelf-link-error',
  );
});

test('unrelated stderr maps to patchelf-failed', () => {
  assert.equal(classifyPatchelfFailure({ status: 1, stderr: 'something else' }), 'patchelf-failed');
});

// classifyPatchelfFailure: 優先順位
test('ENOENT takes priority over link-error stderr', () => {
  assert.equal(
    classifyPatchelfFailure({ code: 'ENOENT', stderr: 'CANNOT LINK EXECUTABLE' }),
    'patchelf-missing',
  );
});

test('EACCES takes priority over ndk1 stderr', () => {
  assert.equal(
    classifyPatchelfFailure({
      code: 'EACCES',
      stderr: 'cannot locate symbol "x" _ZNSt6__ndk1',
    }),
    'patchelf-failed',
  );
});

test('signal takes priority over ndk1 stderr', () => {
  assert.equal(
    classifyPatchelfFailure({
      signal: 'SIGTERM',
      stderr: 'cannot locate symbol "x" _ZNSt6__ndk1',
    }),
    'patchelf-failed',
  );
});

test('ETIMEDOUT takes priority over ndk1 stderr', () => {
  assert.equal(
    classifyPatchelfFailure({
      code: 'ETIMEDOUT',
      stderr: 'cannot locate symbol "x" _ZNSt6__ndk1',
    }),
    'patchelf-failed',
  );
});

test('ndk1 mismatch takes priority over CANNOT LINK EXECUTABLE', () => {
  const stderr = 'CANNOT LINK EXECUTABLE: cannot locate symbol "_ZNSt6__ndk1x"';
  assert.equal(classifyPatchelfFailure({ stderr }), 'patchelf-libcxx-mismatch');
});

// classifyPatchelfFailure: stderr の型
test('Buffer stderr is read as UTF-8', () => {
  const err = { stderr: Buffer.from('CANNOT LINK EXECUTABLE', 'utf8') };
  assert.equal(classifyPatchelfFailure(err), 'patchelf-link-error');
});

test('non-UTF-8 Buffer with ASCII marker still matches', () => {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x80]),
    Buffer.from(' CANNOT LINK EXECUTABLE', 'ascii'),
  ]);
  assert.equal(classifyPatchelfFailure({ stderr: bytes }), 'patchelf-link-error');
});

test('empty stderr with non-zero status maps to patchelf-failed', () => {
  assert.equal(classifyPatchelfFailure({ status: 1, stderr: '' }), 'patchelf-failed');
});

test('undefined stderr maps to patchelf-failed', () => {
  assert.equal(classifyPatchelfFailure({ status: 1 }), 'patchelf-failed');
});

// makeProblem
test('makeProblem returns the expected fields', () => {
  const p = makeProblem('patchelf-missing', 'detail text');
  assert.deepEqual(Object.keys(p).sort(), ['auto', 'code', 'commands', 'detail', 'en', 'ja', 'pkgs', 'repoPkgs']);
  assert.equal(p.code, 'patchelf-missing');
  assert.equal(p.auto, true);
  assert.deepEqual(p.pkgs, ['patchelf', 'libc++']);
  assert.equal(p.ja, PROBLEMS['patchelf-missing'].ja);
  assert.equal(p.en, PROBLEMS['patchelf-missing'].en);
  assert.deepEqual(p.commands, ['pkg install patchelf libc++']);
  assert.equal(p.detail, 'detail text');
});

test('makeProblem copies pkgs and commands', () => {
  const p = makeProblem('patchelf-missing');
  p.pkgs.push('llvm');
  p.commands.push('x');
  assert.deepEqual(PROBLEMS['patchelf-missing'].pkgs, ['patchelf', 'libc++']);
  assert.deepEqual(PROBLEMS['patchelf-missing'].commands, ['pkg install patchelf libc++']);
});

test('makeProblem truncates detail to 2000 characters', () => {
  const p = makeProblem('glibc-missing', 'a'.repeat(2500));
  assert.equal(p.detail.length, 2000);
  assert.equal(p.detail, 'a'.repeat(2000));
});

test('makeProblem defaults detail to empty string', () => {
  assert.equal(makeProblem('glibc-missing').detail, '');
});

test('makeProblem sets detail to empty string for non-string detail', () => {
  assert.equal(makeProblem('glibc-missing', 123).detail, '');
  assert.equal(makeProblem('glibc-missing', null).detail, '');
  assert.equal(makeProblem('glibc-missing', Buffer.from('x')).detail, '');
});

test('makeProblem throws for an unknown code', () => {
  assert.throws(() => makeProblem('no-such-code'), /unknown problem code/);
});

// makeProblem（repoPkgs の複製・全コードの形）
test('makeProblem copies repoPkgs', () => {
  const p = makeProblem('glibc-missing');
  p.repoPkgs.push('x');
  assert.deepEqual(makeProblem('glibc-missing').repoPkgs, ['glibc-repo']);
  assert.deepEqual(PROBLEMS['glibc-missing'].repoPkgs, ['glibc-repo']);
});

test('makeProblem gives an array repoPkgs for every PROBLEMS code', () => {
  const codes = Object.keys(PROBLEMS);
  assert.equal(codes.length, 10);
  for (const code of codes) {
    assert.ok(Array.isArray(makeProblem(code).repoPkgs), `repoPkgs: ${code}`);
  }
});

// buildAutoFix
test('buildAutoFix returns null for an empty list', () => {
  assert.equal(buildAutoFix([]), null);
});

test('buildAutoFix returns null when only manual problems are present', () => {
  const problems = [makeProblem('glibc-broken'), makeProblem('patchelf-link-error')];
  assert.equal(buildAutoFix(problems), null);
});

test('buildAutoFix for patchelf-missing alone', () => {
  assert.deepEqual(buildAutoFix([makeProblem('patchelf-missing')]), {
    steps: [{ args: ['install', 'patchelf', 'libc++'] }],
    pkgs: ['patchelf', 'libc++'],
    args: ['install', 'patchelf', 'libc++'],
    manual: [],
  });
});

test('buildAutoFix for patchelf-missing and readelf-missing', () => {
  assert.deepEqual(
    buildAutoFix([makeProblem('patchelf-missing'), makeProblem('readelf-missing')]),
    {
      steps: [{ args: ['install', 'patchelf', 'libc++', 'llvm'] }],
      pkgs: ['patchelf', 'libc++', 'llvm'],
      args: ['install', 'patchelf', 'libc++', 'llvm'],
      manual: [],
    },
  );
});

test('buildAutoFix for libcxx-mismatch and readelf-missing', () => {
  assert.deepEqual(
    buildAutoFix([makeProblem('patchelf-libcxx-mismatch'), makeProblem('readelf-missing')]),
    {
      steps: [{ args: ['install', 'libc++', 'llvm'] }],
      pkgs: ['libc++', 'llvm'],
      args: ['install', 'libc++', 'llvm'],
      manual: [],
    },
  );
});

test('buildAutoFix for readelf-missing alone', () => {
  assert.deepEqual(buildAutoFix([makeProblem('readelf-missing')]), {
    steps: [{ args: ['install', 'llvm'] }],
    pkgs: ['llvm'],
    args: ['install', 'llvm'],
    manual: [],
  });
});

test('buildAutoFix deduplicates libc++ from patchelf-missing and libcxx-mismatch', () => {
  assert.deepEqual(
    buildAutoFix([makeProblem('patchelf-missing'), makeProblem('patchelf-libcxx-mismatch')]),
    {
      steps: [{ args: ['install', 'patchelf', 'libc++'] }],
      pkgs: ['patchelf', 'libc++'],
      args: ['install', 'patchelf', 'libc++'],
      manual: [],
    },
  );
});

test('buildAutoFix deduplicates llvm from two readelf-missing', () => {
  assert.deepEqual(
    buildAutoFix([makeProblem('readelf-missing'), makeProblem('readelf-missing')]),
    {
      steps: [{ args: ['install', 'llvm'] }],
      pkgs: ['llvm'],
      args: ['install', 'llvm'],
      manual: [],
    },
  );
});

test('buildAutoFix uses fixed package order regardless of input order', () => {
  assert.deepEqual(
    buildAutoFix([makeProblem('readelf-missing'), makeProblem('patchelf-missing')]),
    {
      steps: [{ args: ['install', 'patchelf', 'libc++', 'llvm'] }],
      pkgs: ['patchelf', 'libc++', 'llvm'],
      args: ['install', 'patchelf', 'libc++', 'llvm'],
      manual: [],
    },
  );
});

// buildAutoFix（追加）: 段階の分け方・パッケージ集合・manual・配列の非共有
test('buildAutoFix for glibc-missing alone uses two stages: glibc-repo, then glibc', () => {
  const r = buildAutoFix([makeProblem('glibc-missing')]);
  assert.deepEqual(r.steps.map((s) => s.args), [['install', 'glibc-repo'], ['install', 'glibc']]);
  assert.deepEqual(r.pkgs, ['glibc']);
  assert.deepEqual(r.args, ['install', 'glibc']);
  assert.deepEqual(r.manual, []);
});

test('buildAutoFix for glibc-missing and patchelf-missing puts glibc, patchelf, libc++ in stage 2', () => {
  const r = buildAutoFix([makeProblem('glibc-missing'), makeProblem('patchelf-missing')]);
  assert.deepEqual(r.steps.map((s) => s.args), [
    ['install', 'glibc-repo'],
    ['install', 'glibc', 'patchelf', 'libc++'],
  ]);
});

test('buildAutoFix moves glibc-broken to manual and keeps only auto problems in steps', () => {
  const r = buildAutoFix([makeProblem('glibc-missing'), makeProblem('glibc-broken')]);
  assert.deepEqual(r.manual.map((p) => p.code), ['glibc-broken']);
  assert.deepEqual(r.steps.map((s) => s.args), [['install', 'glibc-repo'], ['install', 'glibc']]);
  assert.deepEqual(r.pkgs, ['glibc']);
});

test('buildAutoFix for tar-missing alone is one stage', () => {
  assert.deepEqual(buildAutoFix([makeProblem('tar-missing')]), {
    steps: [{ args: ['install', 'tar'] }],
    pkgs: ['tar'],
    args: ['install', 'tar'],
    manual: [],
  });
});

test('buildAutoFix for tar-missing, readelf-missing and patchelf-missing uses fixed package order', () => {
  const r = buildAutoFix([
    makeProblem('tar-missing'),
    makeProblem('readelf-missing'),
    makeProblem('patchelf-missing'),
  ]);
  assert.deepEqual(r.steps.map((s) => s.args), [['install', 'patchelf', 'libc++', 'llvm', 'tar']]);
  assert.deepEqual(r.pkgs, ['patchelf', 'libc++', 'llvm', 'tar']);
  assert.deepEqual(r.args, ['install', 'patchelf', 'libc++', 'llvm', 'tar']);
});

test('buildAutoFix with two glibc-missing lists glibc-repo only once', () => {
  const r = buildAutoFix([makeProblem('glibc-missing'), makeProblem('glibc-missing')]);
  assert.deepEqual(r.steps.map((s) => s.args), [['install', 'glibc-repo'], ['install', 'glibc']]);
  assert.deepEqual(r.pkgs, ['glibc']);
});

test('buildAutoFix result does not share arrays with its inputs or PROBLEMS', () => {
  const problems = [makeProblem('glibc-missing'), makeProblem('patchelf-missing'), makeProblem('glibc-broken')];
  const r = buildAutoFix(problems);
  r.steps[0].args.push('x');
  r.steps[1].args.push('x');
  r.pkgs.push('x');
  r.args.push('x');
  r.manual.push('x');
  assert.deepEqual(problems[0].pkgs, ['glibc']);
  assert.deepEqual(problems[0].repoPkgs, ['glibc-repo']);
  assert.deepEqual(problems[1].pkgs, ['patchelf', 'libc++']);
  assert.equal(problems.length, 3);
  assert.deepEqual(makeProblem('glibc-missing').repoPkgs, ['glibc-repo']);
  assert.deepEqual(PROBLEMS['glibc-missing'].pkgs, ['glibc']);
  assert.deepEqual(PROBLEMS['glibc-missing'].repoPkgs, ['glibc-repo']);
  assert.deepEqual(PROBLEMS['patchelf-missing'].pkgs, ['patchelf', 'libc++']);
});

test('buildAutoFix returns null for a non-array input', () => {
  assert.equal(buildAutoFix(null), null);
  assert.equal(buildAutoFix(undefined), null);
  assert.equal(buildAutoFix('glibc-missing'), null);
  assert.equal(buildAutoFix({}), null);
  assert.equal(buildAutoFix([]), null);
});

// PrereqError
test('PrereqError carries exitCode, userMessage and problems', () => {
  const problems = [makeProblem('glibc-missing')];
  const err = new PrereqError({ exitCode: 1, userMessage: 'msg text', problems });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof PrereqError);
  assert.equal(err.name, 'PrereqError');
  assert.equal(err.message, 'msg text');
  assert.equal(err.exitCode, 1);
  assert.equal(err.userMessage, 'msg text');
  assert.equal(err.problems, problems);
});

test('PrereqError accepts exitCode 0', () => {
  const err = new PrereqError({ exitCode: 0, userMessage: 'ok', problems: [] });
  assert.equal(err.exitCode, 0);
});

// checkPrerequisites（U2）: 実コマンド・実ファイルは使わず、すべて差し替える

// 実行失敗を模したエラーを作る
function execError(props) {
  return Object.assign(new Error(props.message || 'Command failed'), props);
}

// spawn の差し替え。table[cmd] にエラーがあれば投げ、なければ成功扱い
function fakeSpawn(table = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (table[cmd]) throw table[cmd];
    return '';
  };
  return { spawn, calls };
}

// fsApi.accessSync の差し替え。err があれば投げる
function fakeFsApi(err = null) {
  const calls = [];
  const accessSync = (p, mode) => {
    calls.push({ p, mode });
    if (err) throw err;
  };
  return { accessSync, calls };
}

test('all checks pass returns an empty list', () => {
  const s = fakeSpawn();
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), []);
});

test('glibc access check uses GLIBC_LD_PATH and X_OK', () => {
  const f = fakeFsApi();
  checkPrerequisites({ spawn: fakeSpawn().spawn, fsApi: f });
  assert.deepEqual(f.calls, [{ p: GLIBC_LD_PATH, mode: fs.constants.X_OK }]);
});

// patchelf の分類（実行失敗の原文は processText の形式）
test('patchelf ENOENT is reported as patchelf-missing', () => {
  const s = fakeSpawn({ patchelf: execError({ code: 'ENOENT', message: 'spawn patchelf ENOENT' }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('patchelf-missing', ''),
  ]);
});

test('patchelf libc++ mismatch is reported with stderr and status in detail', () => {
  const stderr = 'cannot locate symbol "_ZNSt6__ndk113__hash_memoryEPKvm"';
  const s = fakeSpawn({ patchelf: execError({ status: 127, stderr }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('patchelf-libcxx-mismatch', stderr + '\nstatus: 127'),
  ]);
});

test('patchelf CANNOT LINK EXECUTABLE is reported as patchelf-link-error', () => {
  const stderr = 'CANNOT LINK EXECUTABLE "patchelf": library "libc++_shared.so" not found';
  const s = fakeSpawn({ patchelf: execError({ status: 1, stderr }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('patchelf-link-error', stderr + '\nstatus: 1'),
  ]);
});

test('patchelf EACCES, ETIMEDOUT and signal are reported as patchelf-failed', () => {
  const cases = [
    [execError({ code: 'EACCES', message: 'spawn patchelf EACCES' }), ''],
    [execError({ code: 'ETIMEDOUT', message: 'spawnSync patchelf ETIMEDOUT' }), ''],
    [execError({ signal: 'SIGKILL', message: 'killed' }), 'signal: SIGKILL'],
  ];
  for (const [err, detail] of cases) {
    const s = fakeSpawn({ patchelf: err });
    assert.deepEqual(
      checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }),
      [makeProblem('patchelf-failed', detail)],
      `detail: ${detail}`,
    );
  }
});

test('patchelf with empty stderr keeps only status in detail', () => {
  const s = fakeSpawn({ patchelf: execError({ status: 1, stderr: '' }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('patchelf-failed', 'status: 1'),
  ]);
});

test('patchelf Buffer stderr is decoded as UTF-8 in detail', () => {
  const s = fakeSpawn({ patchelf: execError({ status: 1, stderr: Buffer.from('boom', 'utf8') }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('patchelf-failed', 'boom\nstatus: 1'),
  ]);
});

// readelf の分類
test('readelf ENOENT is reported as readelf-missing', () => {
  const s = fakeSpawn({ readelf: execError({ code: 'ENOENT', message: 'spawn readelf ENOENT' }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('readelf-missing', ''),
  ]);
});

test('readelf broken is reported as readelf-failed with stderr and status', () => {
  const s = fakeSpawn({ readelf: execError({ status: 2, stderr: 'readelf: bad' }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('readelf-failed', 'readelf: bad\nstatus: 2'),
  ]);
});

test('readelf EACCES is reported as readelf-failed', () => {
  const s = fakeSpawn({ readelf: execError({ code: 'EACCES', message: 'spawn readelf EACCES' }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('readelf-failed', ''),
  ]);
});

// glibc ローダーの確認
test('glibc loader missing (ENOENT) is reported as glibc-missing and not executed', () => {
  const f = fakeFsApi(execError({ code: 'ENOENT', message: 'ENOENT: no such file' }));
  const s = fakeSpawn();
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: f }), [
    makeProblem('glibc-missing', 'ENOENT: no such file'),
  ]);
  assert.deepEqual(s.calls.map((c) => c.cmd), ['patchelf', 'readelf', 'tar']);
});

test('glibc loader not executable (EACCES) is reported as glibc-broken and not executed', () => {
  const f = fakeFsApi(execError({ code: 'EACCES', message: 'EACCES: permission denied' }));
  const s = fakeSpawn();
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: f }), [
    makeProblem('glibc-broken', 'EACCES: permission denied'),
  ]);
  assert.deepEqual(s.calls.map((c) => c.cmd), ['patchelf', 'readelf', 'tar']);
});

test('glibc loader spawn failure is reported as glibc-broken with message and stderr', () => {
  const s = fakeSpawn({
    [GLIBC_LD_PATH]: execError({ status: 1, message: 'Command failed', stderr: 'loader: cannot run' }),
  });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('glibc-broken', 'Command failed\nloader: cannot run'),
  ]);
});

// 複数の問題を全部集め、検出順（glibc → patchelf → readelf）に返す
test('all missing items are collected in detection order', () => {
  const f = fakeFsApi(execError({ code: 'ENOENT', message: 'ENOENT: glibc' }));
  const s = fakeSpawn({
    patchelf: execError({ code: 'ENOENT', message: 'spawn patchelf ENOENT' }),
    readelf: execError({ code: 'ENOENT', message: 'spawn readelf ENOENT' }),
  });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: f }), [
    makeProblem('glibc-missing', 'ENOENT: glibc'),
    makeProblem('patchelf-missing', ''),
    makeProblem('readelf-missing', ''),
  ]);
});

test('glibc spawn failure does not stop patchelf, readelf and tar checks', () => {
  const s = fakeSpawn({
    [GLIBC_LD_PATH]: execError({ status: 1, message: 'Command failed' }),
    patchelf: execError({ status: 127, stderr: 'cannot locate symbol "_ZNSt6__ndk1x"' }),
    readelf: execError({ status: 1, stderr: 'readelf: error' }),
  });
  const problems = checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() });
  assert.deepEqual(problems.map((p) => p.code), [
    'glibc-broken',
    'patchelf-libcxx-mismatch',
    'readelf-failed',
  ]);
  assert.equal(s.calls.length, 4);
});

// spawn の引数・オプション
test('each spawn call uses --version, pipe stdio, utf8 and 10s timeout', () => {
  const s = fakeSpawn();
  checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() });
  assert.equal(s.calls.length, 4);
  for (const c of s.calls) {
    assert.deepEqual(c.args, ['--version'], `args: ${c.cmd}`);
    assert.deepEqual(c.opts, { stdio: 'pipe', encoding: 'utf8', timeout: 10000 }, `opts: ${c.cmd}`);
  }
});

// spawn の呼び出し順と回数（glibc 正常 → patchelf → readelf → tar の4回）
test('spawn is called in order: glibc loader, patchelf, readelf, tar (4 calls)', () => {
  const s = fakeSpawn();
  checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() });
  assert.deepEqual(s.calls.map((c) => c.cmd), [GLIBC_LD_PATH, 'patchelf', 'readelf', 'tar']);
});

// checkPrerequisites（tar）: 検出の有無・分類・検出順・成功時の呼び出し
test('tar ENOENT is reported as tar-missing at the end of the list', () => {
  const s = fakeSpawn({ tar: execError({ code: 'ENOENT' }) });
  const problems = checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() });
  assert.deepEqual(problems.map((p) => p.code), ['tar-missing']);
  const last = problems[problems.length - 1];
  assert.equal(last.code, 'tar-missing');
  assert.equal(last.auto, true);
  assert.deepEqual(last.pkgs, ['tar']);
});

test('tar non-zero exit is reported as tar-failed with stderr and status in detail', () => {
  const s = fakeSpawn({ tar: execError({ status: 1, stderr: 'x' }) });
  const problems = checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() });
  assert.deepEqual(problems, [makeProblem('tar-failed', 'x\nstatus: 1')]);
  assert.equal(problems[0].auto, false);
});

test('tar timeout with SIGTERM is reported as tar-failed with signal in detail', () => {
  const s = fakeSpawn({ tar: execError({ code: 'ETIMEDOUT', signal: 'SIGTERM' }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('tar-failed', 'signal: SIGTERM'),
  ]);
});

test('tar EACCES without status, stderr or signal is reported as tar-failed with empty detail', () => {
  const s = fakeSpawn({ tar: execError({ code: 'EACCES' }) });
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), [
    makeProblem('tar-failed', ''),
  ]);
});

test('patchelf, readelf and tar failures are detected in order glibc, patchelf, readelf, tar', () => {
  const s = fakeSpawn({
    patchelf: execError({ code: 'ENOENT' }),
    readelf: execError({ code: 'ENOENT' }),
    tar: execError({ code: 'ENOENT' }),
  });
  const problems = checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() });
  assert.deepEqual(problems.map((p) => p.code), ['patchelf-missing', 'readelf-missing', 'tar-missing']);
  assert.deepEqual(s.calls.map((c) => c.cmd), [GLIBC_LD_PATH, 'patchelf', 'readelf', 'tar']);
});

test('all checks pass calls tar once with --version', () => {
  const s = fakeSpawn();
  assert.deepEqual(checkPrerequisites({ spawn: s.spawn, fsApi: fakeFsApi() }), []);
  const tarCalls = s.calls.filter((c) => c.cmd === 'tar');
  assert.equal(tarCalls.length, 1);
  assert.deepEqual(tarCalls[0].args, ['--version']);
});

// ---- resolvePrerequisites の追加テスト（stub のみ使用。実際の pkg / patchelf / readelf / bash は呼ばない） ----
const { resolvePrerequisites } = require('../lib/preflight');

const OK_DEB_TEXT = 'deb https://packages.termux.dev/apt/termux-main stable main\n';
const LEAD_PRECOND = '自動実行の前提を満たさない';
const LEAD_NONINTERACTIVE = '対話できないため';

// 正常な fsApi スタブ: accessSync は引数を記録するだけ、readFileSync は正常な deb 行を返す
function okFs(sourcesText = OK_DEB_TEXT) {
  const accessCalls = [];
  return {
    accessCalls,
    accessSync(p, mode) { accessCalls.push([p, mode]); },
    readFileSync() { return sourcesText; },
  };
}

// accessSync が例外を投げる fsApi スタブ
function accessThrowingFs() {
  const f = okFs();
  f.accessSync = (p, mode) => {
    f.accessCalls.push([p, mode]);
    throw new Error('EACCES');
  };
  return f;
}

// 正常な runSync スタブ: bash は bashResult を返す（関数なら呼び出した結果）、それ以外は status 0
function okRunSync(bashResult = { status: 0, stdout: 'apt', stderr: '' }) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'bash') {
      return typeof bashResult === 'function' ? bashResult() : bashResult;
    }
    return { status: 0 };
  };
  return { calls, fn };
}

function makeStderr() {
  const s = { text: '' };
  s.write = (chunk) => { s.text += chunk; return true; };
  return s;
}

// readline スタブ: createInterface が呼ばれたら記録して例外を投げる
function makeRlStub() {
  const calls = [];
  return {
    calls,
    createInterface(opts) {
      calls.push(opts);
      throw new Error('readline.createInterface must not be called');
    },
  };
}

// PREFIX を一時的に設定し、finally で元の状態に戻す（value が undefined なら未設定にする）
async function withPrefix(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PREFIX');
  const saved = process.env.PREFIX;
  try {
    if (value === undefined) delete process.env.PREFIX;
    else process.env.PREFIX = value;
    return await fn();
  } finally {
    if (had) process.env.PREFIX = saved;
    else delete process.env.PREFIX;
  }
}

// resolvePrerequisites を実行して結果をまとめて返す
// 既定: PREFIX=TERMUX_USR, isTTY=false, 正常スタブ。opts に prefix キーがあればその値（undefined なら未設定）を使う
async function runResolve(problems, opts = {}) {
  const prefix = 'prefix' in opts ? opts.prefix : TERMUX_USR;
  const {
    isTTY = false,
    fsApi = okFs(),
    runSync = okRunSync(),
    check = () => [],
  } = opts;
  const stderr = makeStderr();
  const rl = makeRlStub();
  const io = {
    stdin: {},
    stderr,
    readline: rl,
    spawnSync: runSync.fn,
    fsApi,
    env: { HOME: '/h' },
    check,
    isTTY,
  };
  let err = null;
  await withPrefix(prefix, async () => {
    try {
      await resolvePrerequisites(problems, io);
    } catch (e) {
      err = e;
    }
  });
  return { err, out: stderr.text, runCalls: runSync.calls, rl, fsApi };
}

// 1. 手動のみの問題が混在 → 自動実行せず exitCode 1、spawnSync は一切呼ばれず、各問題の ja/en は stderr に1回ずつ出る
test('mixed manual-only problems: exit 1, no spawnSync call at all, each ja/en printed once', async () => {
  const problems = [makeProblem('glibc-broken'), makeProblem('patchelf-link-error')];
  const r = await runResolve(problems, { isTTY: true });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.runCalls.length, 0);
  for (const p of problems) {
    assert.equal(r.out.split(p.ja).length - 1, 1, `ja once: ${p.code}`);
    assert.equal(r.out.split(p.en).length - 1, 1, `en once: ${p.code}`);
  }
});

// 2. PREFIX が TERMUX_USR 以外 → 自動実行不可（前提条件エラー）、pkg は呼ばれない
test('PREFIX set to other value: auto run not allowed', async () => {
  const r = await runResolve([makeProblem('patchelf-missing')], { prefix: '/other', isTTY: true });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.ok(r.err.userMessage.includes(LEAD_PRECOND));
  assert.equal(r.runCalls.filter((c) => c.cmd === TERMUX_PKG).length, 0);
});

// 2. PREFIX 未設定 → 検査 (a) は通過し、isTTY=false なので非対話の PrereqError
test('PREFIX unset: passes check (a), then non-interactive error', async () => {
  const r = await runResolve([makeProblem('patchelf-missing')], { prefix: undefined, isTTY: false });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.ok(r.err.userMessage.includes(LEAD_NONINTERACTIVE));
  assert.equal(r.rl.calls.length, 0);
});

// 2. PREFIX が TERMUX_USR と一致 → 検査 (a) を通過し、isTTY=false なので非対話の PrereqError
test('PREFIX equal to TERMUX_USR: allowed, then non-interactive error', async () => {
  const r = await runResolve([makeProblem('patchelf-missing')], { prefix: TERMUX_USR, isTTY: false });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.ok(r.err.userMessage.includes(LEAD_NONINTERACTIVE));
});

// 3. pkg が実行可能でない（accessSync が例外）→ 自動実行不可。第1引数は TERMUX_PKG、第2引数は X_OK
test('pkg not executable (accessSync throws): auto run not allowed', async () => {
  const fsApi = accessThrowingFs();
  const r = await runResolve([makeProblem('patchelf-missing')], { fsApi, isTTY: true });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.ok(r.err.userMessage.includes(LEAD_PRECOND));
  assert.equal(r.runCalls.filter((c) => c.cmd === TERMUX_PKG).length, 0);
  assert.equal(fsApi.accessCalls.length, 1);
  assert.equal(fsApi.accessCalls[0][0], TERMUX_PKG);
  assert.equal(fsApi.accessCalls[0][1], fs.constants.X_OK);
});

// 4. パッケージマネージャ判定: bash の呼び出し引数と spawnSync オプションが期待どおり完全一致する
test('package manager check: bash is called with exact args and options', async () => {
  const r = await runResolve([makeProblem('patchelf-missing')], { isTTY: false });
  const bash = r.runCalls.filter((c) => c.cmd === 'bash');
  assert.equal(bash.length, 1);
  assert.deepEqual(bash[0].args, [
    '-c',
    'source "' + PM_SCRIPT + '" && printf %s "$TERMUX_APP_PACKAGE_MANAGER"',
  ]);
  assert.deepEqual(bash[0].opts, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10000,
    env: { HOME: '/h' },
  });
  assert.ok(r.err.userMessage.includes(LEAD_NONINTERACTIVE));
});

// 4. パッケージマネージャ判定の失敗: stdout が 'apt' 以外 / status≠0 / spawnSync が例外 → 自動実行不可
test('package manager check failures: auto run not allowed', async () => {
  const cases = [
    { name: 'stdout pacman', bash: { status: 0, stdout: 'pacman', stderr: '' } },
    { name: 'stdout empty', bash: { status: 0, stdout: '', stderr: '' } },
    { name: 'stdout apt with newline', bash: { status: 0, stdout: 'apt\n', stderr: '' } },
    { name: 'status non-zero', bash: { status: 1, stdout: 'apt', stderr: '' } },
    { name: 'spawnSync throws', bash: () => { throw new Error('spawn failed'); } },
  ];
  for (const c of cases) {
    const r = await runResolve([makeProblem('patchelf-missing')], {
      runSync: okRunSync(c.bash),
      isTTY: true,
    });
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.equal(r.err.exitCode, 1, c.name);
    assert.ok(r.err.userMessage.includes(LEAD_PRECOND), c.name);
    assert.equal(r.runCalls.filter((x) => x.cmd === TERMUX_PKG).length, 0, c.name);
  }
});

// 5. sources.list の判定失敗: deb 行なし / コメントのみ / 最初の deb 行が file: / 読み取り例外 → 自動実行不可
test('sources.list without a usable first deb line: auto run not allowed', async () => {
  const throwingFs = okFs();
  throwingFs.readFileSync = () => { throw new Error('ENOENT'); };
  const cases = [
    { name: 'no deb lines', fsApi: okFs('foo bar\n') },
    { name: 'comments only', fsApi: okFs('# deb https://packages.termux.dev/apt/termux-main stable main\n# comment\n') },
    {
      name: 'first deb is file:',
      fsApi: okFs('deb file:///data/data/com.termux/files/usr/local stable main\n'
        + 'deb https://packages.termux.dev/apt/termux-main stable main\n'),
    },
    { name: 'read throws', fsApi: throwingFs },
  ];
  for (const c of cases) {
    const r = await runResolve([makeProblem('patchelf-missing')], { fsApi: c.fsApi, isTTY: true });
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.equal(r.err.exitCode, 1, c.name);
    assert.ok(r.err.userMessage.includes(LEAD_PRECOND), c.name);
    assert.equal(r.runCalls.filter((x) => x.cmd === TERMUX_PKG).length, 0, c.name);
  }
});

// 5. sources.list: 先頭の空行・コメントの後に http の deb 行がある → 自動実行可（非対話で止まる）
test('sources.list with leading blanks and comments, then http deb line: allowed', async () => {
  const fsApi = okFs('\n\n# comment\n   \n# another\ndeb https://packages.termux.dev/apt/termux-main stable main\n');
  const r = await runResolve([makeProblem('patchelf-missing')], { fsApi, isTTY: false });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.ok(r.err.userMessage.includes(LEAD_NONINTERACTIVE));
});

// 6. isTTY=false → 質問しない（readline 未使用）、PrereqError exitCode 1、pkg は呼ばれない
test('non-TTY stdin: no question, PrereqError exit 1, no pkg run', async () => {
  const r = await runResolve([makeProblem('patchelf-missing')], { isTTY: false });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.rl.calls.length, 0);
  assert.equal(r.runCalls.filter((c) => c.cmd === TERMUX_PKG).length, 0);
});

// 7. describeProblems の内容は stderr に出て、PrereqError.userMessage には ja/en・[code]・コマンドを含む
test('describeProblems goes to stderr; userMessage has ja/en, [code] and commands', async () => {
  const problems = [makeProblem('patchelf-missing'), makeProblem('readelf-missing')];
  const r = await runResolve(problems, { isTTY: false });
  assert.ok(r.err instanceof PrereqError);
  for (const p of problems) {
    assert.ok(r.out.includes(p.ja), `stderr ja: ${p.code}`);
    assert.ok(r.out.includes(p.en), `stderr en: ${p.code}`);
    assert.ok(r.err.userMessage.includes(p.ja), `ja in userMessage: ${p.code}`);
    assert.ok(r.err.userMessage.includes(p.en), `en in userMessage: ${p.code}`);
    assert.ok(r.err.userMessage.includes('[' + p.code + ']'), `code in userMessage: ${p.code}`);
    for (const cmd of p.commands) {
      assert.ok(r.err.userMessage.includes(cmd), `command in userMessage: ${cmd}`);
    }
  }
});

// 8. 前提条件 (a)〜(d) が失敗した場合、userMessage に各問題のコマンド（p.commands）が含まれる
test('precondition failures: userMessage contains every problem command', async () => {
  const problems = [makeProblem('patchelf-missing'), makeProblem('readelf-missing')];
  const scenarios = {
    'PREFIX other': { prefix: '/other' },
    'pkg not executable': { fsApi: accessThrowingFs() },
    'package manager is pacman': { runSync: okRunSync({ status: 0, stdout: 'pacman', stderr: '' }) },
    'sources.list first deb is file:': { fsApi: okFs('deb file:///x stable main\n') },
  };
  for (const [name, o] of Object.entries(scenarios)) {
    const r = await runResolve(problems, { ...o, isTTY: true });
    assert.ok(r.err instanceof PrereqError, name);
    assert.ok(r.err.userMessage.includes(LEAD_PRECOND), name);
    for (const p of problems) {
      for (const cmd of p.commands) {
        assert.ok(r.err.userMessage.includes(cmd), `${name}: ${cmd}`);
      }
    }
  }
});

// ---- 同意の状態遷移（U3 テスト b）----

// readline 偽モジュール。inputs の各要素: 回答文字列 / {eof:true}（close を通知）/ {sigint:true}（SIGINT を通知）
// 要素が尽きた後の question は EOF 扱いにする（想定外の再質問は件数の assert で失敗させる）
// 返り値: { api, record }。record は createInterfaceArgs・prompts・closeCount を持つ
function makeReadline(inputs) {
  const record = { createInterfaceArgs: [], prompts: [], closeCount: 0 };
  const queue = inputs.slice();
  const api = {
    createInterface(opts) {
      record.createInterfaceArgs.push(opts);
      const listeners = {};
      let closeNotified = false;
      const emit = (event) => {
        for (const fn of listeners[event] || []) fn();
      };
      const notifyClose = () => {
        if (closeNotified) return;
        closeNotified = true;
        emit('close');
      };
      const rl = {
        on(event, fn) {
          (listeners[event] = listeners[event] || []).push(fn);
          return rl;
        },
        question(prompt, cb) {
          record.prompts.push(prompt);
          const next = queue.length > 0 ? queue.shift() : { eof: true };
          setImmediate(() => {
            if (next && next.eof) notifyClose();
            else if (next && next.sigint) emit('SIGINT');
            else cb(next);
          });
        },
        close() {
          record.closeCount += 1;
          notifyClose();
        },
      };
      return rl;
    },
  };
  return { api, record };
}

// 同意フローを1回実行する。inputs は makeReadline の入力。PREFIX は未設定にして実行する
async function runConsent(inputs) {
  const problems = [makeProblem('patchelf-missing')];
  const stdin = { isTTY: true };
  const stderr = makeStderr();
  const rl = makeReadline(inputs);
  const runSync = okRunSync();
  const io = {
    stdin,
    stderr,
    readline: rl.api,
    spawnSync: runSync.fn,
    fsApi: okFs(),
    env: {},
    check: () => [],
  };
  let err = null;
  await withPrefix(undefined, async () => {
    try {
      await resolvePrerequisites(problems, io);
    } catch (e) {
      err = e;
    }
  });
  return {
    err,
    out: stderr.text,
    stdin,
    stderr,
    rl: rl.record,
    pkgCalls: runSync.calls.filter((c) => c.cmd === TERMUX_PKG),
  };
}

// 1. 同意: y / yes / Y / YES / 前後空白つきの ' y ' は同意となり、pkg を1回実行する
test('consent: y, yes, Y, YES and padded " y " all agree and run pkg once', async () => {
  for (const ans of ['y', 'yes', 'Y', 'YES', ' y ']) {
    const r = await runConsent([ans]);
    assert.equal(r.err, null, `answer "${ans}"`);
    assert.equal(r.pkgCalls.length, 1, `answer "${ans}"`);
  }
});

// 2. 拒否: n / no / N は即拒否（exitCode 0、pkg なし、質問は1回だけ、close は1回以上）
test('consent: n, no, N refuse at once with exitCode 0 and no pkg run', async () => {
  for (const ans of ['n', 'no', 'N']) {
    const r = await runConsent([ans]);
    assert.ok(r.err instanceof PrereqError, `answer "${ans}"`);
    assert.equal(r.err.exitCode, 0, `answer "${ans}"`);
    assert.equal(r.pkgCalls.length, 0, `answer "${ans}"`);
    assert.equal(r.rl.prompts.length, 1, `answer "${ans}"`);
    assert.ok(r.rl.closeCount >= 1, `answer "${ans}"`);
  }
});

// 3. 空・誤入力は再質問を1回だけ行う（question は最大2回。3回目は無い）
test('consent: an invalid first answer is re-asked exactly once', async () => {
  const cases = [
    { name: 'empty then y', inputs: ['', 'y'], yes: true },
    { name: 'empty then n', inputs: ['', 'n'], yes: false },
    { name: 'empty then empty', inputs: ['', ''], yes: false },
    { name: 'maybe then y', inputs: ['maybe', 'y'], yes: true },
    { name: 'maybe then maybe', inputs: ['maybe', 'maybe'], yes: false },
    // 2回目も誤入力なら拒否。3回目の入力 'y' は読まれない
    { name: 'maybe then maybe then y (third never asked)', inputs: ['maybe', 'maybe', 'y'], yes: false },
  ];
  for (const c of cases) {
    const r = await runConsent(c.inputs);
    assert.equal(r.rl.prompts.length, 2, `${c.name}: question count`);
    if (c.yes) {
      assert.equal(r.err, null, c.name);
      assert.equal(r.pkgCalls.length, 1, c.name);
    } else {
      assert.ok(r.err instanceof PrereqError, c.name);
      assert.equal(r.err.exitCode, 0, c.name);
      assert.equal(r.pkgCalls.length, 0, c.name);
    }
  }
});

// 4. EOF: 1回目・再質問中のどちらでも exitCode 1、pkg なし
test('consent: EOF on the first or second question gives exitCode 1 and no pkg run', async () => {
  const cases = [
    { name: 'EOF on first question', inputs: [{ eof: true }] },
    { name: 'EOF on second question', inputs: ['', { eof: true }] },
  ];
  for (const c of cases) {
    const r = await runConsent(c.inputs);
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.equal(r.err.exitCode, 1, c.name);
    assert.equal(r.pkgCalls.length, 0, c.name);
  }
});

// 5. SIGINT: 1回目・再質問中のどちらでも exitCode 1、pkg なし
test('consent: SIGINT on the first or second question gives exitCode 1 and no pkg run', async () => {
  const cases = [
    { name: 'SIGINT on first question', inputs: [{ sigint: true }] },
    { name: 'SIGINT on second question', inputs: ['', { sigint: true }] },
  ];
  for (const c of cases) {
    const r = await runConsent(c.inputs);
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.equal(r.err.exitCode, 1, c.name);
    assert.equal(r.pkgCalls.length, 0, c.name);
  }
});

// 6. どの経路でも rl.close() が1回呼ばれる。createInterface は input=stdin, output=stderr。prompt に [y/N] を含む
test('consent: rl.close() runs on every path; createInterface gets stdin and stderr; prompt has [y/N]', async () => {
  const paths = [
    { name: 'yes', inputs: ['y'] },
    { name: 'no', inputs: ['n'] },
    { name: 'eof', inputs: [{ eof: true }] },
    { name: 'sigint', inputs: [{ sigint: true }] },
  ];
  for (const p of paths) {
    const r = await runConsent(p.inputs);
    assert.equal(r.rl.closeCount, 1, `${p.name}: close count`);
    assert.equal(r.rl.createInterfaceArgs.length, 1, `${p.name}: createInterface count`);
    const opts = r.rl.createInterfaceArgs[0];
    assert.equal(opts.input, r.stdin, `${p.name}: input is stdin`);
    assert.equal(opts.output, r.stderr, `${p.name}: output is stderr`);
    assert.ok(r.rl.prompts.length >= 1, `${p.name}: at least one question`);
    for (const prompt of r.rl.prompts) {
      assert.ok(prompt.includes('[y/N]'), `${p.name}: prompt has [y/N]`);
    }
  }
});

// 7. 同意画面は stderr に出る（拒否・EOF の場合も表示済み）。日英の主要注意文言と実行コマンドを含む
test('consent screen is written to stderr on every path, with notes and the command', async () => {
  const required = [
    'apt は確認画面を表示せずに実行する場合があります',
    '変更内容はこのツールでは保証されません',
    'apt may run without showing a confirmation prompt',
    'This tool does not guarantee the changes',
    '/data/data/com.termux/files/usr/bin/pkg install patchelf libc++',
  ];
  const cases = [
    { name: 'yes', inputs: ['y'] },
    { name: 'no', inputs: ['n'] },
    { name: 'eof', inputs: [{ eof: true }] },
  ];
  for (const c of cases) {
    const r = await runConsent(c.inputs);
    for (const s of required) {
      assert.ok(r.out.includes(s), `${c.name}: ${s}`);
    }
  }
});

// 8. 拒否・EOF・SIGINT の userMessage は手動コマンドと問題の ja/en 説明文を含む
test('refuse, EOF and SIGINT userMessage has the manual command and ja/en text', async () => {
  const p = makeProblem('patchelf-missing');
  const cases = [
    { name: 'refuse', inputs: ['n'] },
    { name: 'EOF', inputs: [{ eof: true }] },
    { name: 'SIGINT', inputs: [{ sigint: true }] },
  ];
  for (const c of cases) {
    const r = await runConsent(c.inputs);
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.ok(r.err.userMessage.includes('pkg install patchelf libc++'), `${c.name}: manual command`);
    assert.ok(r.err.userMessage.includes(p.ja), `${c.name}: ja`);
    assert.ok(r.err.userMessage.includes(p.en), `${c.name}: en`);
  }
});

// ---- pkg 実行・再検査・ensurePrerequisites（U3 テスト c）----
const { ensurePrerequisites } = require('../lib/preflight');

// pkg 呼び出しの結果だけを差し替える spawnSync スタブ。bash（autoRunAllowed）は okRunSync の既定結果を返す
function pkgSpawn(pkgResult = { status: 0 }) {
  const base = okRunSync();
  const fn = (cmd, args, opts) => {
    if (cmd !== TERMUX_PKG) return base.fn(cmd, args, opts);
    base.calls.push({ cmd, args, opts });
    return typeof pkgResult === 'function' ? pkgResult() : pkgResult;
  };
  return { calls: base.calls, fn };
}

// 呼び出し回数と引数を記録し、n 回目の呼び出しに results[n-1] を返す（尽きたら []）
function scriptedCheck(...results) {
  const calls = [];
  const fn = (arg) => {
    calls.push(arg);
    const r = results[calls.length - 1];
    return r === undefined ? [] : r;
  };
  return { calls, fn };
}

// resolvePrerequisites（ensure=false）または ensurePrerequisites（ensure=true）を1回実行する
// 返り値: { err, out, io, rl, pkgCalls }。io は実行に渡したオブジェクトそのもの
async function runPkgFlow(problems, opts = {}) {
  const {
    inputs = ['y'],
    isTTY = true,
    env = {},
    pkgResult = { status: 0 },
    check = () => [],
    ensure = false,
  } = opts;
  const stderr = makeStderr();
  const rl = makeReadline(inputs);
  const spawn = pkgSpawn(pkgResult);
  const io = {
    stdin: { isTTY },
    stderr,
    readline: rl.api,
    spawnSync: spawn.fn,
    fsApi: okFs(),
    env,
    check,
    isTTY,
  };
  let err = null;
  await withPrefix(undefined, async () => {
    try {
      if (ensure) await ensurePrerequisites(io);
      else await resolvePrerequisites(problems, io);
    } catch (e) {
      err = e;
    }
  });
  return {
    err,
    out: stderr.text,
    io,
    rl: rl.record,
    pkgCalls: spawn.calls.filter((c) => c.cmd === TERMUX_PKG),
  };
}

// 1. 実行引数: 第1引数は固定パス、第2引数は固定 args、第3引数は stdio inherit と env（渡した値を保ち NO_MIRROR_SELECT を足す）
test('pkg run: fixed path, exact args, and options with env kept plus TERMUX_PKG_NO_MIRROR_SELECT', async () => {
  const r = await runPkgFlow([makeProblem('patchelf-missing')], { env: { HOME: '/h', FOO: 'bar' } });
  assert.equal(r.err, null);
  assert.equal(r.pkgCalls.length, 1);
  const [call] = r.pkgCalls;
  assert.equal(call.cmd, '/data/data/com.termux/files/usr/bin/pkg');
  assert.equal(call.cmd, TERMUX_PKG);
  assert.deepEqual(call.args, ['install', 'patchelf', 'libc++']);
  assert.deepEqual(call.opts, {
    stdio: 'inherit',
    env: { HOME: '/h', FOO: 'bar', TERMUX_PKG_NO_MIRROR_SELECT: '1' },
  });
  for (const bad of ['-y', 'upgrade', 'apt-get']) {
    assert.ok(!call.args.includes(bad), `args must not include ${bad}`);
  }
});

// 2. PATH の先頭に偽 pkg を置いても、第1引数は固定パスのまま
test('pkg run: a fake pkg first on PATH does not change the first argument', async () => {
  const r = await runPkgFlow([makeProblem('patchelf-missing')], { env: { PATH: '/fake' } });
  assert.equal(r.err, null);
  assert.equal(r.pkgCalls.length, 1);
  assert.equal(r.pkgCalls[0].cmd, TERMUX_PKG);
  assert.ok(!r.pkgCalls[0].cmd.startsWith('/fake'));
});

// 3. 複数の自動修復可の問題は pkg を1回だけ、統合した args で実行する。同意画面のコマンドも同じ
test('multiple auto-fixable problems: one pkg call with merged args; consent shows the same command', async () => {
  const cases = [
    { codes: ['patchelf-missing', 'readelf-missing'], args: ['install', 'patchelf', 'libc++', 'llvm'] },
    { codes: ['patchelf-libcxx-mismatch', 'readelf-missing'], args: ['install', 'libc++', 'llvm'] },
  ];
  for (const c of cases) {
    const name = c.codes.join('+');
    const r = await runPkgFlow(c.codes.map((code) => makeProblem(code)), {});
    assert.equal(r.err, null, name);
    assert.equal(r.pkgCalls.length, 1, name);
    assert.equal(r.pkgCalls[0].cmd, TERMUX_PKG, name);
    assert.deepEqual(r.pkgCalls[0].args, c.args, name);
    assert.ok(r.out.includes(`${TERMUX_PKG} ${c.args.join(' ')}`), `${name}: consent shows the command`);
  }
});

// 4. pkg の失敗: exitCode 1。userMessage に終了状態・出力参照（ja/en）・手動コマンドを含み、再検査は呼ばれない
test('pkg failure: PrereqError exitCode 1 with state, output reference and manual command; no re-check', async () => {
  const cases = [
    { name: 'status 1', result: { status: 1 }, state: 'status: 1' },
    { name: 'status null', result: { status: null }, state: 'status: null' },
    { name: 'error', result: { error: new Error('boom') }, state: 'error: boom' },
    { name: 'signal', result: { signal: 'SIGTERM', status: null }, state: 'signal: SIGTERM' },
  ];
  for (const c of cases) {
    const scripted = scriptedCheck();
    const r = await runPkgFlow([makeProblem('patchelf-missing')], { pkgResult: c.result, check: scripted.fn });
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.equal(r.err.exitCode, 1, c.name);
    assert.ok(r.err.userMessage.includes(c.state), `${c.name}: state`);
    assert.ok(r.err.userMessage.includes('表示済みの出力を参照'), `${c.name}: ja output reference`);
    assert.ok(r.err.userMessage.includes('See the output shown above'), `${c.name}: en output reference`);
    assert.ok(r.err.userMessage.includes('pkg install patchelf libc++'), `${c.name}: manual command`);
    assert.equal(r.pkgCalls.length, 1, `${c.name}: pkg count`);
    assert.equal(scripted.calls.length, 0, `${c.name}: check must not run`);
  }
});

// 5. 成功後の再検査: check はちょうど1回、同じ io を受け取る。残れば exitCode 1 で、pkg は再実行しない
test('after a successful pkg run: check runs exactly once with the same io; leftovers give exitCode 1 without a second install', async () => {
  const clean = scriptedCheck([]);
  const ok = await runPkgFlow([makeProblem('patchelf-missing')], { check: clean.fn });
  assert.equal(ok.err, null);
  assert.equal(clean.calls.length, 1);
  assert.equal(clean.calls[0], ok.io);

  const left = scriptedCheck([makeProblem('patchelf-libcxx-mismatch')]);
  const ng = await runPkgFlow([makeProblem('patchelf-missing')], { check: left.fn });
  assert.ok(ng.err instanceof PrereqError);
  assert.equal(ng.err.exitCode, 1);
  assert.equal(ng.pkgCalls.length, 1, 'no second install');
  assert.equal(left.calls.length, 1);
  assert.equal(left.calls[0], ng.io);
  assert.ok(ng.err.userMessage.includes('pkg install libc++'), 'manual command for the leftover problem');
});

// 6. ensurePrerequisites: 問題なしは readline も pkg も呼ばない。問題ありの成功は計2回の check と pkg1回。非TTY は pkg なし
test('ensurePrerequisites: no problems → no readline or pkg; fixed → check twice, pkg once; non-TTY → exitCode 1', async () => {
  const none = scriptedCheck([]);
  const r1 = await runPkgFlow([], { ensure: true, check: none.fn });
  assert.equal(r1.err, null);
  assert.equal(none.calls.length, 1);
  assert.equal(r1.rl.createInterfaceArgs.length, 0);
  assert.equal(r1.pkgCalls.length, 0);

  const fixed = scriptedCheck([makeProblem('patchelf-missing')], []);
  const r2 = await runPkgFlow([], { ensure: true, isTTY: true, inputs: ['y'], pkgResult: { status: 0 }, check: fixed.fn });
  assert.equal(r2.err, null);
  assert.equal(fixed.calls.length, 2);
  assert.equal(r2.pkgCalls.length, 1);

  const nonTty = scriptedCheck([makeProblem('patchelf-missing')]);
  const r3 = await runPkgFlow([], { ensure: true, isTTY: false, check: nonTty.fn });
  assert.ok(r3.err instanceof PrereqError);
  assert.equal(r3.err.exitCode, 1);
  assert.equal(nonTty.calls.length, 1);
  assert.equal(r3.pkgCalls.length, 0);
});

// 7. 手動のみ混在を ensurePrerequisites で実行 → exitCode 1、pkg なし、check は1回
test('ensurePrerequisites: manual-only mix → exitCode 1, no pkg run, check once', async () => {
  const scripted = scriptedCheck([makeProblem('glibc-broken'), makeProblem('patchelf-link-error')]);
  const r = await runPkgFlow([], { ensure: true, check: scripted.fn });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.pkgCalls.length, 0);
  assert.equal(scripted.calls.length, 1);
});

// ---- resolvePrerequisites の多段実行・混在・再検査（I2c）----

// pkg 呼び出しごとに results[n] を返す（尽きたら status 0）。段ごとに結果を変えるために使う
function stagedPkg(...results) {
  let n = 0;
  return () => {
    const r = results[n];
    n += 1;
    return r === undefined ? { status: 0 } : r;
  };
}

// 混在（自動: patchelf-libcxx-mismatch、手動: glibc-broken）の問題一覧
function mixedProblems() {
  return [makeProblem('patchelf-libcxx-mismatch'), makeProblem('glibc-broken')];
}

// 1. glibc-missing だけ: glibc-repo → glibc の2段を順に実行し、再検査は1回。同意画面に番号付きの2コマンドと glibc-repo の注意を出す
test('multi-stage: glibc-missing runs glibc-repo then glibc, check once, numbered commands and repo notes shown', async () => {
  const check = scriptedCheck();
  const r = await runPkgFlow([makeProblem('glibc-missing')], { check: check.fn });
  assert.equal(r.err, null);
  assert.equal(r.pkgCalls.length, 2);
  assert.deepEqual(r.pkgCalls.map((c) => c.args), [['install', 'glibc-repo'], ['install', 'glibc']]);
  for (const call of r.pkgCalls) {
    assert.equal(call.opts.stdio, 'inherit');
    assert.equal(call.opts.env.TERMUX_PKG_NO_MIRROR_SELECT, '1');
  }
  assert.equal(check.calls.length, 1);
  assert.ok(r.out.includes(`  1. ${TERMUX_PKG} install glibc-repo`));
  assert.ok(r.out.includes(`  2. ${TERMUX_PKG} install glibc`));
  assert.ok(r.out.includes('glibc-repo の導入はリポジトリ設定を永続的に変更します'));
  assert.ok(r.out.includes('Installing glibc-repo permanently changes the repository settings'));
});

// 2. glibc-missing と patchelf-missing: 2段目は glibc, patchelf, libc++ を1回の pkg install にまとめる
test('multi-stage: glibc-missing with patchelf-missing makes stage 2 install glibc patchelf libc++', async () => {
  const check = scriptedCheck();
  const r = await runPkgFlow([makeProblem('glibc-missing'), makeProblem('patchelf-missing')], { check: check.fn });
  assert.equal(r.err, null);
  assert.deepEqual(r.pkgCalls.map((c) => c.args), [['install', 'glibc-repo'], ['install', 'glibc', 'patchelf', 'libc++']]);
  assert.equal(check.calls.length, 1);
});

// 3. 1段目の失敗（status / signal / error のどれでも）: 2段目は実行せず、再検査もしない。変更がなかった保証がない旨を案内する
test('multi-stage: stage 1 failure (status, signal or error) stops before stage 2 and skips check', async () => {
  const cases = [
    { name: 'status 1', result: { status: 1 }, state: 'status: 1' },
    { name: 'signal SIGTERM', result: { signal: 'SIGTERM', status: null }, state: 'signal: SIGTERM' },
    { name: 'error', result: { error: new Error('spawn failed'), status: null }, state: 'error: spawn failed' },
  ];
  for (const c of cases) {
    const check = scriptedCheck();
    const r = await runPkgFlow([makeProblem('glibc-missing')], { pkgResult: stagedPkg(c.result), check: check.fn });
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.equal(r.err.exitCode, 1, c.name);
    assert.equal(r.pkgCalls.length, 1, c.name);
    assert.equal(check.calls.length, 0, c.name);
    assert.ok(r.err.userMessage.includes('1 段目'), c.name);
    assert.ok(r.err.userMessage.includes('変更がなかった保証はありません'), c.name);
    assert.ok(r.err.userMessage.includes(c.state), c.name);
  }
});

// 4. 1段目成功・2段目失敗（status 2）: リポジトリ設定の変更可能性を案内し、再検査はしない
test('multi-stage: stage 1 success and stage 2 failure reports possible repo changes and skips check', async () => {
  const check = scriptedCheck();
  const r = await runPkgFlow([makeProblem('glibc-missing')], {
    pkgResult: stagedPkg({ status: 0 }, { status: 2 }),
    check: check.fn,
  });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.pkgCalls.length, 2);
  assert.equal(check.calls.length, 0);
  assert.ok(r.err.userMessage.includes('1 段目は成功し、リポジトリ設定などが変更されている可能性があります'));
  assert.ok(r.err.userMessage.includes('2 段目'));
  assert.ok(r.err.userMessage.includes('status: 2'));
});

// 5. 両段成功後も glibc-missing が残る: 再実行せず手動案内で終わる。実行した段と終了状態、pkg reinstall glibc の案内を含む
test('multi-stage: both stages succeed but glibc-missing remains gives manual guidance without rerun', async () => {
  const check = scriptedCheck([makeProblem('glibc-missing')]);
  const r = await runPkgFlow([makeProblem('glibc-missing')], { check: check.fn });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.pkgCalls.length, 2);
  assert.equal(check.calls.length, 1);
  const m = r.err.userMessage;
  const g = makeProblem('glibc-missing');
  assert.ok(m.includes('自動実行後も問題が残っています'));
  assert.ok(m.includes('  - [glibc-missing]'));
  assert.ok(m.includes('実行した段と終了状態'));
  assert.ok(m.includes(`  1. ${TERMUX_PKG} install glibc-repo → status: 0`));
  assert.ok(m.includes(`  2. ${TERMUX_PKG} install glibc → status: 0`));
  assert.ok(m.includes('pkg reinstall glibc'));
  assert.ok(m.includes(g.ja));
  assert.ok(m.includes(g.en));
});

// 6. 両段成功後に readelf-failed が残る（新しい問題種別）: 日英説明と手動コマンド pkg install llvm を案内する
test('multi-stage: both stages succeed but readelf-failed remains gives its ja/en text and manual command', async () => {
  const check = scriptedCheck([makeProblem('readelf-failed')]);
  const r = await runPkgFlow([makeProblem('glibc-missing')], { check: check.fn });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.pkgCalls.length, 2);
  assert.equal(check.calls.length, 1);
  const p = makeProblem('readelf-failed');
  assert.ok(r.err.userMessage.includes(p.ja));
  assert.ok(r.err.userMessage.includes(p.en));
  assert.ok(r.err.userMessage.includes('pkg install llvm'));
});

// 7(a). 混在: 同意画面に手動項目の見出しと glibc-broken の手動コマンドを出し、実行は libc++ の1段だけ。再検査で残った glibc-broken を案内する
test('mixed auto and manual: consent lists manual items, runs only the libc++ stage, reports remaining glibc-broken', async () => {
  const check = scriptedCheck([makeProblem('glibc-broken')]);
  const r = await runPkgFlow(mixedProblems(), { inputs: ['y'], check: check.fn });
  assert.ok(r.out.includes('手動で対応が必要な項目（自動では実行しません） / Items that need manual action (not run automatically):'));
  assert.ok(r.out.includes('pkg install glibc-repo && pkg install glibc'));
  assert.deepEqual(r.pkgCalls.map((c) => c.args), [['install', 'libc++']]);
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  const g = makeProblem('glibc-broken');
  assert.ok(r.err.userMessage.includes(g.ja));
  assert.ok(r.err.userMessage.includes(g.en));
  assert.equal(check.calls.length, 1);
});

// 7(b)(c)(d). 混在: 拒否は exitCode 0、EOF と SIGINT は exitCode 1。いずれも pkg と再検査は動かない
test('mixed auto and manual: refusal, EOF and SIGINT never run pkg or check', async () => {
  const cases = [
    { name: 'refuse', inputs: ['n'], exitCode: 0 },
    { name: 'EOF', inputs: [{ eof: true }], exitCode: 1 },
    { name: 'SIGINT', inputs: [{ sigint: true }], exitCode: 1 },
  ];
  for (const c of cases) {
    const check = scriptedCheck();
    const r = await runPkgFlow(mixedProblems(), { inputs: c.inputs, check: check.fn });
    assert.ok(r.err instanceof PrereqError, c.name);
    assert.equal(r.err.exitCode, c.exitCode, c.name);
    assert.equal(r.pkgCalls.length, 0, c.name);
    assert.equal(check.calls.length, 0, c.name);
  }
});

// 7(e). 混在・非TTY: 同意画面は出さず、pkg も動かさず、手動コマンドを案内する
test('mixed auto and manual: non-TTY shows no consent screen and gives manual guidance', async () => {
  const check = scriptedCheck();
  const r = await runPkgFlow(mixedProblems(), { isTTY: false, inputs: [], check: check.fn });
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.pkgCalls.length, 0);
  assert.equal(check.calls.length, 0);
  assert.equal(r.rl.createInterfaceArgs.length, 0);
  assert.ok(!r.out.includes('次の前提条件を自動で修復します'));
  assert.ok(r.err.userMessage.includes('pkg install libc++'));
  assert.ok(r.err.userMessage.includes('pkg install glibc-repo && pkg install glibc'));
});

// 7(f). 混在: libc++ の1段を実行し、再検査で問題が無ければ正常終了する
test('mixed auto and manual: when the re-check finds no problems, resolve after the libc++ stage', async () => {
  const check = scriptedCheck();
  const r = await runPkgFlow(mixedProblems(), { check: check.fn });
  assert.equal(r.err, null);
  assert.deepEqual(r.pkgCalls.map((c) => c.args), [['install', 'libc++']]);
  assert.equal(check.calls.length, 1);
});

// 8. 1段だけ（自動: patchelf-libcxx-mismatch）: 同意画面に glibc-repo の注意を出さず、pkg が status 1 で失敗すると終了状態を案内する
test('single stage: no glibc-repo note on consent, and pkg status 1 gives the status failure message', async () => {
  const check = scriptedCheck();
  const r = await runPkgFlow([makeProblem('patchelf-libcxx-mismatch')], {
    pkgResult: stagedPkg({ status: 1 }),
    check: check.fn,
  });
  assert.ok(!r.out.includes('glibc-repo の導入はリポジトリ設定を永続的に変更します'));
  assert.ok(r.err instanceof PrereqError);
  assert.equal(r.err.exitCode, 1);
  assert.equal(r.pkgCalls.length, 1);
  assert.equal(check.calls.length, 0);
  assert.ok(r.err.userMessage.includes('pkg install が終了状態 status: 1 で失敗しました'));
});
