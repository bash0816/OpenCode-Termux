'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { applyPatchelf, verifyInterpreter, GLIBC_LD_PATH, GLIBC_LIB_DIR } = require('./patcher');
const { fetchPackageMetadata, fetchWithIntegrity } = require('./downloader');

const CACHE_DIR = path.join(os.homedir(), '.opencode-termux');
const INSTALLS_DIR = path.join(CACHE_DIR, 'installs');
const CURRENT_LINK = path.join(CACHE_DIR, 'current');

// --- プロセス生存確認(ロックではなく、tmp清掃の安全性判定にのみ使う) ---

function getProcessStartTime(pid) {
  // /proc/<pid>/stat を読み、comm フィールド(カッコ内、空白を含みうる)の
  // 直後(lastIndexOf(')') + 2 の位置)から空白区切りでフィールドを分割し、
  // 19番目(0-indexed、starttimeフィールド)を**文字列のまま**返す。
  // 読み取り失敗時はnullを返す(例外を投げない)。
  // ★重要: 戻り値の型は必ずstringで統一すること(numberに変換しない)。
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const closeParenIdx = stat.lastIndexOf(')');
    if (closeParenIdx === -1) {
      return null;
    }
    const fields = stat.substring(closeParenIdx + 2).split(' ');
    // starttimeフィールドは19番目(0-indexed)
    if (fields.length < 20) {
      return null;
    }
    return fields[19]; // string として返す
  } catch (e) {
    return null;
  }
}

function isAliveOrUnknown(pid, expectedStartTime) {
  // expectedStartTimeは文字列(またはnull)。
  // 1. process.kill(pid, 0) を試みる。
  //    - 成功したら(例外なし)、生存中と分かる。この場合:
  //      - getProcessStartTime(pid)で現在のstarttimeを取得。
  //      - expectedStartTimeがnullでなく、現在のstarttime(string)と文字列として不一致なら
  //        false(pid再利用による死亡)を返す。
  //      - それ以外はtrue(生存中)を返す。
  //    - 例外が出たら、e.code を見る:
  //      - 'ESRCH' → false を返す(OSが「存在しない」と明言、確実に死亡)
  //      - 'EPERM' → true を返す(他uidが使用中、安全側に倒して残す)
  //      - それ以外 → true を返す(想定外、安全側に倒して残す)
  try {
    process.kill(pid, 0);
    // 生存中
    const currentStartTime = getProcessStartTime(pid);
    if (currentStartTime === null) {
      return true; // 生存確認はできたがstarttime取得に失敗、安全側で残す
    }
    if (expectedStartTime !== null && currentStartTime !== expectedStartTime) {
      return false; // pid再利用が確認できた
    }
    return true; // 生存中
  } catch (e) {
    if (e.code === 'ESRCH') {
      return false; // 確実に死亡
    }
    // EPERM または その他 → 安全側に倒す
    return true;
  }
}

// --- tmp清掃(ロックなし、pid+starttime埋め込みの名前から死亡確認できたものだけ削除) ---

function cleanupStaleTmp() {
  // INSTALLS_DIRが存在しなければ何もせず return。
  if (!fs.existsSync(INSTALLS_DIR)) {
    return;
  }

  // INSTALLS_DIR配下を readdirSync し、`.tmp-` で始まる名前だけを対象にする。
  // 各名前を正規表現でパースする。名前の形式は
  // `.tmp-${version}-${pid}-${startTimeOrUnknown}-${uuid}` 。
  // versionにハイフンが含まれうる(例: "2.0.16-beta")ため、**末尾から**UUID(36文字、
  // ハイフンあり標準形式)を切り出し、その直前のハイフン区切り2要素をstartTime・pidとして
  // 取り出す設計にすること。
  const entries = fs.readdirSync(INSTALLS_DIR);
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  for (const entry of entries) {
    if (!entry.startsWith('.tmp-')) {
      continue;
    }

    const fullPath = path.join(INSTALLS_DIR, entry);
    // entry = ".tmp-<version>-<pid>-<startTime>-<uuid>"
    // 末尾36文字を切り出し
    if (entry.length < 41) {
      // ".tmp-" (5) + uuid (36) の最小で41字
      continue;
    }

    const uuid = entry.slice(-36);
    if (!uuidRegex.test(uuid)) {
      // UUID形式でない→パース不能→放置
      continue;
    }

    // UUIDの直前に"-"があるはず。その前のハイフン区切り部分をパース
    const beforeUuid = entry.slice(0, -37); // "-uuid" 手前まで (末尾37文字削除)
    // beforeUuid = ".tmp-<version>-<pid>-<startTime>"
    // 末尾から逆算: 最後の2つのハイフン区切り要素が startTime, pid

    const beforeUuidParts = beforeUuid.split('-');
    if (beforeUuidParts.length < 3) {
      // .tmp, version, pid, startTime が必須
      continue;
    }

    const pidStr = beforeUuidParts[beforeUuidParts.length - 2];
    const startTimeStr = beforeUuidParts[beforeUuidParts.length - 1];

    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      continue;
    }

    const expectedStartTime = startTimeStr === 'unknown' ? null : startTimeStr;

    if (isAliveOrUnknown(pid, expectedStartTime)) {
      // プロセス生存中 → 削除しない
      continue;
    }

    // プロセス死亡 → 削除
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch (e) {
      // 削除失敗しても処理続行
    }
  }
}

// --- 再利用判定・ローカル検証 ---

function readMarkerSafe(dir) {
  // path.join(dir, '.marker.json') をJSON.parseして返す。失敗したらnullを返す(例外を投げない)。
  try {
    const content = fs.readFileSync(path.join(dir, '.marker.json'), 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function verifyLocal(binDir, expectedVersion) {
  // binDir/bin/opencode に対して以下4項目を確認し、いずれか失敗したら例外を投げる:
  // 1. verifyInterpreter(binPath) が true であること(patcher.jsの関数を使う)
  // 2. GLIBC_LD_PATH が存在し実行可能(fs.accessSync等)であること
  // 3. (簡易版でよい) GLIBC_LIB_DIR が存在すること
  // 4. `env -u LD_PRELOAD LD_LIBRARY_PATH=<GLIBC_LIB_DIR> <binPath> --version` を
  //    execFileSyncでタイムアウト30000ms付きで実行し、exit 0・stdout出力に
  //    expectedVersion文字列が含まれることを確認する。
  //    ★重要: LD_PRELOADを空文字列にする(process.envをコピーしてLD_PRELOAD: ''で
  //    上書きしたenvをexecFileSyncのoptions.envに渡す)。

  const binPath = path.join(binDir, 'bin', 'opencode');

  // 1. Interpreter check
  if (!verifyInterpreter(binPath)) {
    throw new Error(`Interpreter verification failed for ${binPath}`);
  }

  // 2. GLIBC loader exists and executable
  try {
    fs.accessSync(GLIBC_LD_PATH, fs.constants.X_OK);
  } catch (e) {
    throw new Error(`GLIBC loader not found or not executable: ${GLIBC_LD_PATH}`);
  }

  // 3. GLIBC lib dir exists
  if (!fs.existsSync(GLIBC_LIB_DIR)) {
    throw new Error(`GLIBC lib directory not found: ${GLIBC_LIB_DIR}`);
  }

  // 4. Version check
  const env = Object.assign({}, process.env, { LD_PRELOAD: '', LD_LIBRARY_PATH: GLIBC_LIB_DIR });
  const output = execFileSync(binPath, ['--version'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    env,
    encoding: 'utf-8',
  });

  if (!output.includes(expectedVersion)) {
    throw new Error(`Version check failed: output does not contain "${expectedVersion}"`);
  }
}

function resolveValidCurrent(expectedVersion) {
  let target;
  try {
    target = fs.realpathSync(CURRENT_LINK);
  } catch (e) {
    return null;
  }
  const marker = readMarkerSafe(target);
  if (!marker || marker.version !== expectedVersion) return null;
  try {
    verifyLocal(target, expectedVersion);
  } catch (e) {
    return null;
  }
  return target;
}

function isCurrentValid(expectedVersion) {
  return resolveValidCurrent(expectedVersion) !== null;
}

// --- メインのsetup関数 ---

async function setup(version) {
  fs.mkdirSync(INSTALLS_DIR, { recursive: true }); // ★INSTALLS_DIRが無い初回のため必須
  cleanupStaleTmp(); // ロック取得なしで直接呼ぶ(ロック機構自体を採用しない設計)
  const currentTarget = resolveValidCurrent(version);
  if (currentTarget !== null) return currentTarget;

  const uuid = crypto.randomUUID();
  const startTime = getProcessStartTime(process.pid); // string または null
  const ownerTag = `${process.pid}-${startTime !== null ? startTime : 'unknown'}-${uuid}`;
  const tmp = path.join(INSTALLS_DIR, `.tmp-${version}-${ownerTag}`);
  const dst = path.join(INSTALLS_DIR, `${version}-${uuid}`);

  fs.mkdirSync(dst); // 排他確保。既存ならEEXIST例外がそのまま伝播してsetup失敗(tmpは
                      // まだ作っていないので後始末不要)
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const meta = await fetchPackageMetadata(version);
    const tarballBuf = await fetchWithIntegrity(meta.dist.tarball, meta.dist.integrity);
    const tarballPath = path.join(tmp, 'download.tgz');
    fs.writeFileSync(tarballPath, tarballBuf);
    execFileSync('tar', ['-xzf', tarballPath, '-C', tmp, '--strip-components=1']);
    fs.rmSync(tarballPath, { force: true });
    const binPath = path.join(tmp, 'bin', 'opencode');
    if (!fs.existsSync(binPath)) {
      throw new Error(`extracted package missing bin/opencode at ${binPath}`);
    }
    applyPatchelf(binPath);
    fs.renameSync(tmp, dst); // dstは自分がmkdirSyncで作った空dirなので安全(POSIX rename
                              // は空dirへの置換を許可する)
    verifyLocal(dst, version);
    fs.writeFileSync(path.join(dst, '.marker.json'), JSON.stringify({
      version, interpreter: GLIBC_LD_PATH, createdAt: Date.now(),
    }, null, 2));
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
    throw e;
  }
  swapCurrent(dst);
  return dst;
}

function swapCurrent(dst) {
  const tmpLink = path.join(CACHE_DIR, `current.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  // ★current.tmp.<pid>だけだと同一pidの再利用でEEXIST衝突しうるため、ランダムサフィックスを付与
  try { fs.unlinkSync(tmpLink); } catch (_) {}
  fs.symlinkSync(dst, tmpLink);
  fs.renameSync(tmpLink, CURRENT_LINK); // アトミック
}

module.exports = { setup, CACHE_DIR, INSTALLS_DIR, CURRENT_LINK, isCurrentValid, verifyLocal, cleanupStaleTmp, getProcessStartTime, isAliveOrUnknown };
