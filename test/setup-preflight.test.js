'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// テスト用 HOME は setup.js の読み込み前に設定する(CACHE_DIR は読み込み時の os.homedir() で決まる)
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-preflight-'));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;

const { setup, CACHE_DIR, INSTALLS_DIR } = require('../lib/setup');
const { PrereqError } = require('../lib/preflight');

const VERSION = '9.9.9-test';

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

// io スタブ。呼び出し回数を数え、ensure 時点の INSTALLS_DIR の存在を記録する。
// fetchPackageMetadata は例外で止める(実ネットワーク・実 tar・実 patchelf は一切使わない)。
// resolveValidCurrent は既定で null を返す(実 readelf・実バイナリ起動を避ける)。resolveImpl で差し替え可能。
function makeIo({ ensureImpl, resolveImpl } = {}) {
  const calls = {
    ensure: 0,
    meta: 0,
    tar: 0,
    resolve: 0,
    installsExistedAtEnsure: null,
    installsExistedAtResolve: null,
  };
  const io = {
    resolveValidCurrent: (v) => {
      calls.resolve += 1;
      calls.installsExistedAtResolve = fs.existsSync(INSTALLS_DIR);
      return resolveImpl ? resolveImpl(v) : null;
    },
    ensurePrerequisites: async () => {
      calls.ensure += 1;
      calls.installsExistedAtEnsure = fs.existsSync(INSTALLS_DIR);
      if (ensureImpl) return ensureImpl();
    },
    fetchPackageMetadata: async () => {
      calls.meta += 1;
      throw new Error('stub: stop after fetchPackageMetadata');
    },
    fetchWithIntegrity: async () => {
      calls.tar += 1;
      throw new Error('stub: stop after fetchWithIntegrity');
    },
  };
  return { io, calls };
}

test('(2) invalid current calls ensurePrerequisites exactly once before fetching', async () => {
  // CACHE_DIR を消した状態 = current が存在しない = 無効な current
  const { io, calls } = makeIo();
  await assert.rejects(setup(VERSION, io), /stub: stop after fetchPackageMetadata/);
  assert.equal(calls.ensure, 1);
  assert.equal(calls.meta, 1);
  assert.equal(calls.tar, 0);
});

test('(3) ensurePrerequisites throwing PrereqError creates no dst dir and no fetch', async () => {
  const { io, calls } = makeIo({
    ensureImpl: () => {
      throw new PrereqError({ exitCode: 1, userMessage: 'stub prereq failure', problems: [] });
    },
  });
  await assert.rejects(setup(VERSION, io), (e) => {
    assert.ok(e instanceof PrereqError, `expected PrereqError, got ${e && e.name}`);
    return true;
  });
  assert.equal(calls.ensure, 1);
  assert.equal(calls.meta, 0);
  assert.equal(calls.tar, 0);
  const created = fs.readdirSync(INSTALLS_DIR).filter((name) => name.startsWith(`${VERSION}-`));
  assert.deepEqual(created, []);
});

test('(4) INSTALLS_DIR is prepared before ensurePrerequisites is called (fresh HOME)', async () => {
  assert.equal(fs.existsSync(INSTALLS_DIR), false, 'precondition: INSTALLS_DIR absent on fresh HOME');
  const { io, calls } = makeIo({
    ensureImpl: () => {
      throw new PrereqError({ exitCode: 1, userMessage: 'stub prereq failure', problems: [] });
    },
  });
  await assert.rejects(setup(VERSION, io), PrereqError);
  assert.equal(calls.ensure, 1);
  assert.equal(calls.installsExistedAtEnsure, true);
});

// INSTALLS_DIR 内の `${VERSION}-*` エントリ一覧(INSTALLS_DIR が無ければ空)
function listVersionDirs() {
  if (!fs.existsSync(INSTALLS_DIR)) return [];
  return fs.readdirSync(INSTALLS_DIR).filter((name) => name.startsWith(`${VERSION}-`));
}

test('(1) valid current: setup returns it with zero ensure/fetch calls and creates no version dir', async () => {
  const before = listVersionDirs();
  const { io, calls } = makeIo({ resolveImpl: () => '/fake/current' });
  const result = await setup(VERSION, io);
  assert.equal(result, '/fake/current');
  assert.equal(calls.ensure, 0);
  assert.equal(calls.meta, 0);
  assert.equal(calls.tar, 0);
  assert.deepEqual(listVersionDirs(), before);
});

test('(1b) valid current: resolveValidCurrent is called once, after INSTALLS_DIR is prepared', async () => {
  assert.equal(fs.existsSync(INSTALLS_DIR), false, 'precondition: INSTALLS_DIR absent on fresh HOME');
  const { io, calls } = makeIo({ resolveImpl: () => '/fake/current' });
  await setup(VERSION, io);
  assert.equal(calls.resolve, 1);
  assert.equal(calls.installsExistedAtResolve, true);
});

test('(5) resolveValidCurrent returning null: ensurePrerequisites is called once before fetching', async () => {
  const { io, calls } = makeIo({ resolveImpl: () => null });
  await assert.rejects(setup(VERSION, io), /stub: stop after fetchPackageMetadata/);
  assert.equal(calls.resolve, 1);
  assert.equal(calls.ensure, 1);
  assert.equal(calls.meta, 1);
  assert.equal(calls.tar, 0);
});
