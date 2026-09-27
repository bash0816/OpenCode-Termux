'use strict';
const { execFileSync } = require('child_process');

const GLIBC_LD_PATH = '/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1';
const GLIBC_LIB_DIR = '/data/data/com.termux/files/usr/glibc/lib';

function applyPatchelf(binPath) {
  // patchelf --set-interpreter <GLIBC_LD_PATH> <binPath> を実行。
  // patchelfコマンドが見つからない場合(ENOENT)は、
  // 「pkg install patchelf を実行してください」という分かりやすいエラーメッセージで例外を投げる。
  // patchelf自体の終了コードが非0の場合もエラーとして例外を投げる。
  try {
    execFileSync('patchelf', ['--set-interpreter', GLIBC_LD_PATH, binPath], {
      stdio: 'pipe',
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('patchelf not found. Run "pkg install patchelf" to install it.');
    }
    throw e;
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
