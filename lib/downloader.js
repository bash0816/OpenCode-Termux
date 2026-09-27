'use strict';
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const REGISTRY = 'https://registry.npmjs.org';
const UPSTREAM_PACKAGE = '@opencode/cli-linux-arm64';

function httpsGet(url, headers) {
  // リダイレクト追従つきのHTTPS GET。Promiseでbufferを返す。
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const makeRequest = (currentUrl, redirects) => {
      const currentUrlObj = new URL(currentUrl);
      const options = {
        hostname: currentUrlObj.hostname,
        port: currentUrlObj.port || undefined,
        path: currentUrlObj.pathname + currentUrlObj.search,
        method: 'GET',
        headers: headers || {},
      };
      https.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects >= 5) {
            return reject(new Error('too many redirects'));
          }
          // 相対パスを現在のURLに対して解決してリダイレクトする。
          return makeRequest(new URL(res.headers.location, currentUrl).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    };

    makeRequest(urlObj.toString(), 0);
  });
}

async function fetchPackageMetadata(version) {
  // `${REGISTRY}/${encodeURIComponent(UPSTREAM_PACKAGE)}/${version}` にGETし、
  // JSON.parseした結果を返す(dist.tarball, dist.integrityを含む)。
  const url = `${REGISTRY}/${encodeURIComponent(UPSTREAM_PACKAGE)}/${version}`;
  const buf = await httpsGet(url);
  return JSON.parse(buf.toString('utf-8'));
}

async function fetchWithIntegrity(url, expectedIntegrity) {
  // expectedIntegrityは "sha512-xxxxx==" のようなSRI形式。
  // algo(sha512等)とbase64値に分解し、ダウンロードしたbufferのハッシュを計算、
  // crypto.timingSafeEqualで比較する。長さが異なる場合は先にlengthチェックしてから比較
  // (timingSafeEqualは長さが違うと例外を投げるため)。不一致なら例外を投げる。
  const buf = await httpsGet(url);

  // SRI形式をパース: "algo-hashvalue" または "algo-hashvalue==" (padding含む)
  const [algo, hashWithPadding] = expectedIntegrity.split('-');
  if (!algo || !hashWithPadding) {
    throw new Error(`Invalid SRI format: ${expectedIntegrity}`);
  }

  // base64文字列をBufferに変換
  const expectedHash = Buffer.from(hashWithPadding, 'base64');

  // ダウンロードしたデータのハッシュを計算
  const hash = crypto.createHash(algo);
  hash.update(buf);
  const actualHash = hash.digest();

  // 長さが異なる場合は先にチェック
  if (expectedHash.length !== actualHash.length) {
    throw new Error(`Integrity check failed for ${url}: hash length mismatch (expected ${expectedHash.length}, got ${actualHash.length})`);
  }

  // タイミング攻撃耐性のある比較
  if (!crypto.timingSafeEqual(expectedHash, actualHash)) {
    throw new Error(`Integrity check failed for ${url}: hash mismatch`);
  }

  return buf;
}

module.exports = { fetchPackageMetadata, fetchWithIntegrity, UPSTREAM_PACKAGE };
