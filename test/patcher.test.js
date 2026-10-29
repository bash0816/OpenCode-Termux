'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPatchelf, GLIBC_LD_PATH } = require('../lib/patcher');
const { PrereqError, makeProblem } = require('../lib/preflight');

const BIN = '/x/bin/opencode';

function expectPrereq(props, code) {
  const err = Object.assign(new Error(props.message || 'Command failed: patchelf'), props);
  const raw = ((props.stderr || '') || err.message).trim();
  const expected = makeProblem(code, raw);
  assert.throws(
    () => applyPatchelf(BIN, { execFileSync: () => { throw err; } }),
    (thrown) => {
      assert.ok(thrown instanceof PrereqError, `expected PrereqError, got ${thrown && thrown.name}`);
      assert.equal(thrown.exitCode, 1);
      assert.equal(thrown.problems.length, 1);
      assert.equal(thrown.problems[0].code, code);
      assert.ok(thrown.userMessage.includes(expected.ja), 'userMessage must include ja text');
      assert.ok(thrown.userMessage.includes(expected.en), 'userMessage must include en text');
      assert.ok(thrown.userMessage.includes(expected.detail), 'userMessage must include raw detail');
      for (const c of expected.commands || []) {
        assert.ok(thrown.userMessage.includes(c), `userMessage must include command: ${c}`);
      }
      return true;
    }
  );
}

test('success runs patchelf with the glibc interpreter and does not throw', () => {
  const calls = [];
  applyPatchelf(BIN, {
    execFileSync: (...args) => { calls.push(args); return Buffer.from(''); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'patchelf');
  assert.deepEqual(calls[0][1], ['--set-interpreter', GLIBC_LD_PATH, BIN]);
  assert.deepEqual(calls[0][2], { stdio: 'pipe' });
});

test('ENOENT becomes PrereqError patchelf-missing', () => {
  expectPrereq({ code: 'ENOENT', message: 'spawn patchelf ENOENT' }, 'patchelf-missing');
});

test('EACCES becomes PrereqError patchelf-failed', () => {
  expectPrereq({ code: 'EACCES', message: 'spawn patchelf EACCES' }, 'patchelf-failed');
});

test('ETIMEDOUT becomes PrereqError patchelf-failed', () => {
  expectPrereq({ code: 'ETIMEDOUT', message: 'spawnSync patchelf ETIMEDOUT' }, 'patchelf-failed');
});

test('termination by signal becomes PrereqError patchelf-failed', () => {
  expectPrereq({ signal: 'SIGKILL', stderr: 'killed', message: 'Command failed: patchelf' }, 'patchelf-failed');
});

test('libc++ symbol mismatch becomes PrereqError patchelf-libcxx-mismatch', () => {
  expectPrereq({
    status: 1,
    stderr: 'patchelf: cannot locate symbol "_ZNSt6__ndk113__hash_memoryEPKvm"\n',
    message: 'Command failed: patchelf',
  }, 'patchelf-libcxx-mismatch');
});

test('linker error becomes PrereqError patchelf-link-error', () => {
  expectPrereq({
    status: 1,
    stderr: 'CANNOT LINK EXECUTABLE "patchelf": library "libfoo.so" not found\n',
    message: 'Command failed: patchelf',
  }, 'patchelf-link-error');
});

test('non-zero exit with empty stderr becomes PrereqError patchelf-failed', () => {
  expectPrereq({ status: 127, stderr: '', message: 'Command failed: patchelf --set-interpreter' }, 'patchelf-failed');
});

test('userMessage includes status, signal and code lines when present', () => {
  const err = Object.assign(new Error('Command failed: patchelf'), {
    status: 1, signal: 'SIGTERM', code: 'EACCES', stderr: 'boom',
  });
  assert.throws(
    () => applyPatchelf(BIN, { execFileSync: () => { throw err; } }),
    (thrown) => {
      assert.ok(thrown instanceof PrereqError);
      const lines = thrown.userMessage.split('\n');
      assert.ok(lines.includes('status: 1'), 'status line missing');
      assert.ok(lines.includes('signal: SIGTERM'), 'signal line missing');
      assert.ok(lines.includes('code: EACCES'), 'code line missing');
      return true;
    }
  );
});

test('userMessage omits status, signal and code lines when they are null or undefined', () => {
  const err = Object.assign(new Error('Command failed: patchelf'), {
    status: null, signal: null, stderr: 'boom',
  });
  assert.throws(
    () => applyPatchelf(BIN, { execFileSync: () => { throw err; } }),
    (thrown) => {
      assert.ok(thrown instanceof PrereqError);
      const lines = thrown.userMessage.split('\n');
      assert.equal(lines.some((l) => l.startsWith('status:')), false);
      assert.equal(lines.some((l) => l.startsWith('signal:')), false);
      assert.equal(lines.some((l) => l.startsWith('code:')), false);
      return true;
    }
  );
});
