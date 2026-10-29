'use strict';
const { execFileSync } = require('child_process');
const { PrereqError, classifyPatchelfFailure, makeProblem } = require('./preflight');

const GLIBC_LD_PATH = '/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1';
const GLIBC_LIB_DIR = '/data/data/com.termux/files/usr/glibc/lib';

// patchelfの失敗(生のエラー)を、分類済みの PrereqError に変換する。
function toPrereqError(e) {
  const code = classifyPatchelfFailure(e);
  const stderr = Buffer.isBuffer(e.stderr)
    ? e.stderr.toString('utf8')
    : (typeof e.stderr === 'string' ? e.stderr : '');
  const raw = (stderr || e.message || '').trim();
  const problem = makeProblem(code, raw);
  const lines = [problem.ja, problem.en];
  if (problem.detail) {
    lines.push(`詳細: ${problem.detail}`);
  }
  if (e.status != null) lines.push(`status: ${e.status}`);
  if (e.signal != null) lines.push(`signal: ${e.signal}`);
  if (e.code != null) lines.push(`code: ${e.code}`);
  if (Array.isArray(problem.commands) && problem.commands.length > 0) {
    lines.push(`手動で実行する場合: ${problem.commands.join(' ; ')}`);
  }
  return new PrereqError({ exitCode: 1, userMessage: lines.join('\n'), problems: [problem] });
}

function applyPatchelf(binPath, deps = {}) {
  const run = deps.execFileSync || execFileSync;
  // patchelf --set-interpreter <GLIBC_LD_PATH> <binPath> を実行。
  // 失敗はすべて分類して PrereqError に変換する(原文・status・signal・手動コマンドを含む)。
  try {
    run('patchelf', ['--set-interpreter', GLIBC_LD_PATH, binPath], {
      stdio: 'pipe',
    });
  } catch (e) {
    throw toPrereqError(e);
  }
}

function verifyInterpreter(binPath) {
  // readelf -l <binPath> を実行し、出力から
  // "Requesting program interpreter: <path>]" という行を正規表現で抽出する。
  // 抽出した値がGLIBC_LD_PATHと完全一致するかを確認し、真偽値を返す(例外は投げない、
  // 呼び出し元が判断できるようbooleanを返す関数にする)。
  // readelf自体が見つからない/失敗した場合はfalseを返す。
  try {
    const output = execFileSync('readelf', ['-l', binPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const match = output.match(/Requesting program interpreter: ([^\]]+)\]/);
    if (!match) {
      return false;
    }
    const interpreter = match[1];
    return interpreter === GLIBC_LD_PATH;
  } catch (e) {
    return false;
  }
}

module.exports = { applyPatchelf, verifyInterpreter, GLIBC_LD_PATH, GLIBC_LIB_DIR };
