'use strict';

// 前提条件チェック（U1: 純関数部、U2: checkPrerequisites、U3: 同意と自動修復）。

const fs = require('fs');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const TERMUX_USR = '/data/data/com.termux/files/usr';
const TERMUX_PKG = TERMUX_USR + '/bin/pkg';
const SOURCES_LIST = TERMUX_USR + '/etc/apt/sources.list';
const PM_SCRIPT = TERMUX_USR + '/bin/termux-setup-package-manager';
const GLIBC_LD_PATH = TERMUX_USR + '/glibc/lib/ld-linux-aarch64.so.1';

// 自動修復の固定順序
const PKG_ORDER = ['glibc', 'patchelf', 'libc++', 'llvm', 'tar'];

// 問題コードごとの固定値
const PROBLEMS = {
  'glibc-missing': {
    auto: true,
    pkgs: ['glibc'],
    repoPkgs: ['glibc-repo'],
    ja: 'glibc のローダーが見つかりません',
    en: 'glibc loader not found',
    commands: ['pkg install glibc-repo && pkg install glibc'],
  },
  'glibc-broken': {
    auto: false,
    pkgs: [],
    repoPkgs: [],
    ja: 'glibc のローダーを実行できません',
    en: 'glibc loader cannot be executed',
    commands: ['pkg install glibc-repo && pkg install glibc'],
  },
  'patchelf-missing': {
    auto: true,
    pkgs: ['patchelf', 'libc++'],
    repoPkgs: [],
    ja: 'patchelf が見つかりません',
    en: 'patchelf not found',
    commands: ['pkg install patchelf libc++'],
  },
  'patchelf-libcxx-mismatch': {
    auto: true,
    pkgs: ['libc++'],
    repoPkgs: [],
    ja: 'patchelf が libc++ の不一致で起動できません（libc++ が古い可能性があります）',
    en: 'patchelf cannot start due to a libc++ mismatch (the installed libc++ may be too old)',
    commands: ['pkg install libc++'],
  },
  'patchelf-link-error': {
    auto: false,
    pkgs: [],
    repoPkgs: [],
    ja: 'patchelf のリンクエラーです。『pkg update && pkg upgrade』は全パッケージを更新します',
    en: "patchelf failed to link. 'pkg update && pkg upgrade' updates ALL installed packages",
    commands: ['pkg update && pkg upgrade'],
  },
  'patchelf-failed': {
    auto: false,
    pkgs: [],
    repoPkgs: [],
    ja: 'patchelf を実行できません',
    en: 'patchelf cannot be executed',
    commands: ['pkg install patchelf libc++'],
  },
  'readelf-missing': {
    auto: true,
    pkgs: ['llvm'],
    repoPkgs: [],
    ja: 'readelf が見つかりません',
    en: 'readelf not found',
    commands: ['pkg install llvm'],
  },
  'readelf-failed': {
    auto: false,
    pkgs: [],
    repoPkgs: [],
    ja: 'readelf を実行できません',
    en: 'readelf cannot be executed',
    commands: ['pkg install llvm'],
  },
  'tar-missing': {
    auto: true,
    pkgs: ['tar'],
    repoPkgs: [],
    ja: 'tar が見つかりません',
    en: 'tar not found',
    commands: ['pkg install tar'],
  },
  'tar-failed': {
    auto: false,
    pkgs: [],
    repoPkgs: [],
    ja: 'tar を実行できません',
    en: 'tar cannot be executed',
    commands: ['pkg install tar'],
  },
};

// 原文の先頭を最大 2000 文字に切る
const DETAIL_MAX = 2000;

// 問題オブジェクトを作る。detail は文字列以外なら ''
function makeProblem(code, detail = '') {
  const p = PROBLEMS[code];
  if (!p) {
    throw new Error('unknown problem code: ' + code);
  }
  return {
    code,
    auto: p.auto,
    pkgs: [...p.pkgs],
    repoPkgs: [...p.repoPkgs],
    ja: p.ja,
    en: p.en,
    commands: [...p.commands],
    detail: typeof detail === 'string' ? detail.slice(0, DETAIL_MAX) : '',
  };
}

// err.stderr を文字列にする（Buffer は UTF-8 として読む）
function toText(v) {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'string') return v;
  return '';
}

// patchelf の実行失敗を問題コードに分類する（優先順位は上から）
function classifyPatchelfFailure(err) {
  const e = err || {};
  const stderrText = toText(e.stderr);
  if (e.code === 'ENOENT') return 'patchelf-missing';
  if (e.code === 'EACCES') return 'patchelf-failed';
  if (e.code === 'ETIMEDOUT' || e.signal) return 'patchelf-failed';
  if (stderrText.includes('cannot locate symbol') && stderrText.includes('_ZNSt6__ndk1')) {
    return 'patchelf-libcxx-mismatch';
  }
  if (
    stderrText.includes('CANNOT LINK EXECUTABLE') ||
    stderrText.includes('cannot locate symbol') ||
    /library ".*" not found/.test(stderrText)
  ) {
    return 'patchelf-link-error';
  }
  return 'patchelf-failed';
}

// 前提条件の失敗。userMessage は表示用、exitCode は 0 または 1
class PrereqError extends Error {
  constructor({ exitCode, userMessage, problems }) {
    super(userMessage);
    this.name = 'PrereqError';
    this.exitCode = exitCode;
    this.userMessage = userMessage;
    this.problems = problems;
  }
}

// 自動修復の許可リストを作る。自動対象が無ければ null。手動案内は manual に分けて返す
function buildAutoFix(problems) {
  if (!Array.isArray(problems) || problems.length === 0) return null;
  const auto = problems.filter((p) => p.auto === true);
  if (auto.length === 0) return null;
  const pkgSet = new Set();
  const repoSet = new Set();
  for (const p of auto) {
    for (const pkg of p.pkgs) pkgSet.add(pkg);
    for (const repo of p.repoPkgs) repoSet.add(repo);
  }
  const pkgs = PKG_ORDER.filter((pkg) => pkgSet.has(pkg));
  const repoPkgs = [...repoSet];
  const steps =
    repoPkgs.length > 0
      ? [{ args: ['install', ...repoPkgs] }, { args: ['install', ...pkgs] }]
      : [{ args: ['install', ...pkgs] }];
  const args = [...steps[steps.length - 1].args];
  const manual = problems.filter((p) => p.auto === false);
  return { steps, pkgs, args, manual };
}

// 例外の原文（message と stderr）を1つの文字列にする
function errorText(e) {
  const err = e || {};
  const parts = [];
  if (typeof err.message === 'string' && err.message) parts.push(err.message);
  const stderr = toText(err.stderr);
  if (stderr) parts.push(stderr);
  return parts.join('\n');
}

// 実行失敗の原文（stderr と status／signal）を1つの文字列にする
function processText(e) {
  const err = e || {};
  const parts = [];
  const stderr = toText(err.stderr);
  if (stderr) parts.push(stderr);
  if (err.status !== undefined && err.status !== null) parts.push('status: ' + err.status);
  if (err.signal) parts.push('signal: ' + err.signal);
  return parts.join('\n');
}

// glibc・patchelf・readelf の存在と実行可否を調べ、問題を全部集めて返す（検出順）
function checkPrerequisites(io = {}) {
  const spawn = io.spawn || execFileSync;
  const fsApi = io.fsApi || fs;
  const opts = { stdio: 'pipe', encoding: 'utf8', timeout: 10000 };
  const problems = [];

  // glibc ローダー: 存在・実行権限を確認してから起動を試す
  let glibcAccessible = true;
  try {
    fsApi.accessSync(GLIBC_LD_PATH, fs.constants.X_OK);
  } catch (e) {
    glibcAccessible = false;
    const code = e && e.code === 'ENOENT' ? 'glibc-missing' : 'glibc-broken';
    problems.push(makeProblem(code, errorText(e)));
  }
  if (glibcAccessible) {
    try {
      spawn(GLIBC_LD_PATH, ['--version'], opts);
    } catch (e) {
      problems.push(makeProblem('glibc-broken', errorText(e)));
    }
  }

  // patchelf: 失敗の種類を分類する
  try {
    spawn('patchelf', ['--version'], opts);
  } catch (e) {
    problems.push(makeProblem(classifyPatchelfFailure(e), processText(e)));
  }

  // readelf: 見つからない場合と実行失敗を分ける
  try {
    spawn('readelf', ['--version'], opts);
  } catch (e) {
    const code = e && e.code === 'ENOENT' ? 'readelf-missing' : 'readelf-failed';
    problems.push(makeProblem(code, processText(e)));
  }

  // tar: 見つからない場合と実行失敗を分ける
  try {
    spawn('tar', ['--version'], opts);
  } catch (e) {
    const code = e && e.code === 'ENOENT' ? 'tar-missing' : 'tar-failed';
    problems.push(makeProblem(code, processText(e)));
  }

  return problems;
}

// 手動案内の見出し（ja / en）
const LEAD = {
  manualOnly:
    '自動では修復できません。次を手動で実行してください / Cannot repair automatically. Run these manually:',
  precondition:
    '自動実行の前提を満たさないため、次を手動で実行してください / Automatic run prerequisites not met. Run these manually:',
  nonInteractive:
    '対話できないため自動実行しません。次を手動で実行してください / Not running automatically without an interactive terminal. Run these manually:',
  refused:
    '実行を取り消しました。次を手動で実行してください / Cancelled. Run these manually:',
  noInput:
    '入力がないため中止しました。次を手動で実行してください / Aborted: no input. Run these manually:',
  remaining:
    '自動実行後も問題が残っています（pkg は再実行しません）。次を手動で実行してください / Problems remain after the automatic run (pkg was not run again). Run these manually:',
};

// pkg install の失敗見出し（終了状態を含む）
function pkgFailedLead(state) {
  return (
    'pkg install が終了状態 ' + state + ' で失敗しました。表示済みの出力を参照してください / ' +
    'pkg install failed (' + state + '). See the output shown above. Manual commands:'
  );
}

// 段の失敗見出し（index は 0 始まりの段番号。state は終了状態の文字列）
function stageFailedLead(index, command, state) {
  if (index === 0) {
    return (
      '1 段目 ' + command + ' が終了状態 ' + state + ' で失敗しました。変更がなかった保証はありません。以降の段は実行していません。表示済みの出力を参照してください / ' +
      'Stage 1 (' + command + ') failed (' + state + '). It is not guaranteed that nothing changed. Later stages were not run. See the output shown above. Manual commands:'
    );
  }
  return (
    '1 段目は成功し、リポジトリ設定などが変更されている可能性があります。' + (index + 1) + ' 段目 ' + command + ' が終了状態 ' + state + ' で失敗しました。表示済みの出力を参照してください / ' +
    'Earlier stages succeeded and repository settings may have been changed. Stage ' + (index + 1) + ' (' + command + ') failed (' + state + '). See the output shown above. Manual commands:'
  );
}

// 実行した段の一覧と、glibc のローダーが残っている場合の診断（自動では再実行しない）
function glibcRemainingNote(steps) {
  const lines = ['実行した段と終了状態 / Stages run and exit status:'];
  steps.forEach((step, i) => {
    lines.push('  ' + (i + 1) + '. ' + TERMUX_PKG + ' ' + step.args.join(' ') + ' → status: 0');
  });
  lines.push(
    'glibc のローダーが残っています。glibc パッケージは入っていてもローダーだけ欠けている場合があります。状態を確認し、必要なら pkg reinstall glibc を検討してください（自動では再実行しません） / ' +
    'The glibc loader is still missing. The glibc package may be installed while only the loader is absent. Check its state and consider pkg reinstall glibc if needed (it is not run automatically).'
  );
  return lines.join('\n') + '\n';
}

// 手順 1: 全問題の説明と手動 commands を表示する文面
function describeProblems(problems) {
  const lines = ['[opencode-termux] 前提条件の問題 / Prerequisite problems'];
  for (const p of problems) {
    lines.push('- ' + p.ja + ' / ' + p.en);
    for (const cmd of p.commands) lines.push('    手動 / Manual: ' + cmd);
  }
  return lines.join('\n') + '\n';
}

// 最終の手動案内: 問題コードと説明、その手動 commands を並べる
function manualText(lead, problems) {
  const lines = [lead];
  for (const p of problems) {
    lines.push('  - [' + p.code + '] ' + p.ja + ' / ' + p.en);
    for (const cmd of p.commands) lines.push('      手動 / Manual: ' + cmd);
  }
  return lines.join('\n') + '\n';
}

function manualError(exitCode, lead, problems) {
  return new PrereqError({ exitCode, userMessage: manualText(lead, problems), problems });
}

// 同意画面の注意書き（ja, en の組）
const CONSENT_NOTES = [
  [
    'Termux 標準の pkg install を実行します。リポジトリ索引の更新（apt update）が行われる場合があります。ミラー設定は通常は変更しません（実行時の状態次第で変更される場合があります）。',
    'This runs the standard Termux pkg install. The package index may be updated (apt update). Mirror settings are normally not changed (they may change depending on the runtime state).',
  ],
  [
    '依存関係により他のパッケージが追加・更新・削除される場合があります。変更内容はこのツールでは保証されません。',
    'Other packages may be added, updated or removed as dependencies. This tool does not guarantee the changes.',
  ],
  [
    'apt は確認画面を表示せずに実行する場合があります。',
    'apt may run without showing a confirmation prompt.',
  ],
  [
    '一部のパッケージだけの更新により他のプログラムに影響が出る場合があります。',
    'Updating only some packages may affect other programs.',
  ],
  [
    'libc++ などは手動インストール扱いになる場合があります。',
    'libc++ and similar packages may be treated as manual installs.',
  ],
  [
    '全体更新（pkg upgrade）ではありません。',
    'This is not a full upgrade (pkg upgrade).',
  ],
];

// リポジトリ追加（glibc-repo）を含む場合の注意書き（ja, en の組）
const REPO_NOTES = [
  [
    'glibc-repo の導入はリポジトリ設定を永続的に変更します。既に導入済みの場合は新規追加とは限りません。',
    'Installing glibc-repo permanently changes the repository settings. If it is already installed, this may not be a new addition.',
  ],
  [
    '元の状態に完全に戻せる保証はありません。削除が必要な場合は、依存関係などの影響を確認したうえで手動で行ってください。',
    'There is no guarantee that the original state can be fully restored. If removal is needed, check the impact on dependencies first and do it manually.',
  ],
];

// 同意画面（手順 5）
function consentText(problems, fix) {
  const lines = ['[opencode-termux] 次の前提条件を自動で修復します / Automatic repair of prerequisites'];
  for (const p of problems) if (p.auto === true) lines.push('- ' + p.ja + ' / ' + p.en);
  if (fix.manual.length > 0) {
    lines.push('手動で対応が必要な項目（自動では実行しません） / Items that need manual action (not run automatically):');
    for (const p of fix.manual) {
      lines.push('- ' + p.ja + ' / ' + p.en);
      for (const cmd of p.commands) lines.push('    手動 / Manual: ' + cmd);
    }
  }
  if (fix.steps.length === 1) {
    lines.push('実行するコマンド / Command: ' + TERMUX_PKG + ' ' + fix.steps[0].args.join(' '));
  } else {
    lines.push('実行するコマンド（上から順に実行します） / Commands (run in this order):');
    fix.steps.forEach((step, i) => lines.push('  ' + (i + 1) + '. ' + TERMUX_PKG + ' ' + step.args.join(' ')));
  }
  for (const [ja, en] of CONSENT_NOTES) lines.push('注意 / Note: ' + ja + ' / ' + en);
  if (fix.steps.length >= 2) {
    for (const [ja, en] of REPO_NOTES) lines.push('注意 / Note: ' + ja + ' / ' + en);
  }
  return lines.join('\n') + '\n';
}

const CONSENT_PROMPT = '続行しますか？ [y/N] / Proceed? [y/N]: ';

// 1 回の質問に対する回答を待つ。回答・close（EOF）・SIGINT のうち最初の1つで決まる
function readAnswer(rl) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    rl.on('close', () => settle({ kind: 'eof' }));
    rl.on('SIGINT', () => settle({ kind: 'sigint' }));
    rl.question(CONSENT_PROMPT, (text) => settle({ kind: 'answer', text: String(text) }));
  });
}

// 同意の回答を読む（手順 6）。'yes' | 'no' | 'eof' | 'sigint' を返す。空・その他は1回だけ再質問
async function askConsent(rl) {
  const first = await readAnswer(rl);
  if (first.kind !== 'answer') return first.kind;
  const a = first.text.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'yes';
  if (a === 'n' || a === 'no') return 'no';
  const second = await readAnswer(rl);
  if (second.kind !== 'answer') return second.kind;
  const b = second.text.trim().toLowerCase();
  return b === 'y' || b === 'yes' ? 'yes' : 'no';
}

// 自動実行の前提確認（手順 3）。(a)〜(d) を上から評価し、最初の不成立で false
function autoRunAllowed({ fsApi, env, runSync }) {
  // (a) PREFIX が設定され TERMUX_USR と異なるなら不可（process.env を読む）
  const prefix = process.env.PREFIX;
  if (prefix !== undefined && prefix !== TERMUX_USR) return false;

  // (b) pkg が実行可能か
  try {
    fsApi.accessSync(TERMUX_PKG, fs.constants.X_OK);
  } catch (e) {
    return false;
  }

  // (c) パッケージマネージャーが apt か（stdout は完全一致）
  try {
    const r = runSync(
      'bash',
      ['-c', 'source "' + PM_SCRIPT + '" && printf %s "$TERMUX_APP_PACKAGE_MANAGER"'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, env }
    );
    if (r.status !== 0 || r.stdout !== 'apt') return false;
  } catch (e) {
    return false;
  }

  // (d) sources.list の最初の有効な deb 行から https?:// の URL を取り出せるか
  let text;
  try {
    text = fsApi.readFileSync(SOURCES_LIST, 'utf8');
  } catch (e) {
    return false;
  }
  const debLine = String(text).split(/\r?\n/).find((l) => /^\s*deb\s+/.test(l));
  if (debLine === undefined) return false;
  return /https?:\/\/[^ ]+/.test(debLine);
}

// 問題を自動修復する（手順 1〜8）。成功時は resolve、失敗・拒否は PrereqError を throw
async function resolvePrerequisites(problems, io = {}) {
  const {
    stdin = process.stdin,
    stderr = process.stderr,
    readline: readlineApi = readline,
    spawnSync: runSync = spawnSync,
    fsApi = fs,
    env = process.env,
    check = checkPrerequisites,
  } = io;
  const isTTY = io.isTTY !== undefined ? io.isTTY : stdin.isTTY;

  // 1. 全問題の日英説明と手動 commands を表示する
  stderr.write(describeProblems(problems));

  // 2. 自動修復の許可リスト。手動のみが混ざるなら手動案内で終わる
  const fix = buildAutoFix(problems);
  if (fix === null) {
    throw manualError(1, LEAD.manualOnly, problems);
  }

  // 3. 自動実行の前提を確認する。不成立なら自動実行せず手動案内
  if (!autoRunAllowed({ fsApi, env, runSync })) {
    throw manualError(1, LEAD.precondition, problems);
  }

  // 4. 非対話なら質問せず手動案内
  if (!isTTY) {
    throw manualError(1, LEAD.nonInteractive, problems);
  }

  // 5. 同意画面を表示する
  stderr.write(consentText(problems, fix));

  // 6. 同意を読む。どの経路でも rl を閉じてから次へ進む
  const rl = readlineApi.createInterface({ input: stdin, output: stderr });
  let decision;
  try {
    decision = await askConsent(rl);
  } finally {
    rl.close();
  }
  if (decision === 'no') {
    throw manualError(0, LEAD.refused, problems);
  }
  if (decision !== 'yes') {
    // EOF または SIGINT
    throw manualError(1, LEAD.noInput, problems);
  }

  // 7. 固定パスの pkg を段ごとに先頭から実行する（PATH の内容に依らない）。段が失敗したら後続の段は実行しない
  for (let i = 0; i < fix.steps.length; i++) {
    const step = fix.steps[i];
    const r = runSync(TERMUX_PKG, step.args, {
      stdio: 'inherit',
      env: { ...env, TERMUX_PKG_NO_MIRROR_SELECT: '1' },
    });
    if (r.error || r.signal || r.status !== 0) {
      let state;
      if (r.error) state = 'error: ' + (r.error.message || String(r.error));
      else if (r.signal) state = 'signal: ' + r.signal;
      else state = 'status: ' + r.status;
      const lead =
        fix.steps.length === 1
          ? pkgFailedLead(state)
          : stageFailedLead(i, TERMUX_PKG + ' ' + step.args.join(' '), state);
      throw manualError(1, lead, problems);
    }
  }

  // 8. 再検査は全段の後に1回だけ。残れば再実行せず手動案内で終わる
  const remaining = check(io);
  if (remaining.length === 0) return;
  let lead = LEAD.remaining;
  if (remaining.some((p) => p.code === 'glibc-missing')) {
    lead = LEAD.remaining + '\n' + glibcRemainingNote(fix.steps).replace(/\n$/, '');
  }
  throw manualError(1, lead, remaining);
}

// 前提を調べ、問題があれば解決を試みる
async function ensurePrerequisites(io = {}) {
  const problems = (io.check || checkPrerequisites)(io);
  if (problems.length === 0) return;
  await resolvePrerequisites(problems, io);
}

module.exports = {
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
  resolvePrerequisites,
  ensurePrerequisites,
};
