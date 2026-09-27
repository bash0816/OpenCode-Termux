#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { fetchWithIntegrity } = require('../lib/downloader');
const { applyPatchelf, verifyInterpreter } = require('../lib/patcher');
const { normalizeVersion, getTokyoDate } = require('../lib/version-utils');

const UPSTREAM_PACKAGE = '@opencode/cli-linux-arm64';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(new URL(res.headers.location, url).toString()).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const rawVersion = process.argv[2];
  if (!rawVersion) {
    console.error('Usage: prepare-opencode-candidate.js <version>');
    process.exit(1);
  }
  try {
    const version = normalizeVersion(rawVersion);
    const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(UPSTREAM_PACKAGE)}/${encodeURIComponent(version)}`;
    const upstream = JSON.parse((await httpsGet(metadataUrl)).toString('utf8'));
    const tarballUrl = upstream && upstream.dist && upstream.dist.tarball;
    const expectedIntegrity = upstream && upstream.dist && upstream.dist.integrity;
    if (!tarballUrl || !expectedIntegrity) throw new Error(`npm metadata for ${version} is missing dist.tarball or dist.integrity`);

    const tarball = await fetchWithIntegrity(tarballUrl, expectedIntegrity);
    const sha256Tar = crypto.createHash('sha256').update(tarball).digest('hex');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-candidate-'));
    let patchelfVerified = false;
    try {
      const archivePath = path.join(tmpDir, 'upstream.tgz');
      fs.writeFileSync(archivePath, tarball);
      execFileSync('tar', ['-xzf', archivePath, '--strip-components=1'], { cwd: tmpDir, stdio: 'pipe' });
      const binaryPath = path.join(tmpDir, 'bin', 'opencode');
      if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
        throw new Error('Extracted tarball does not contain bin/opencode');
      }
      const patchedCopy = path.join(tmpDir, 'opencode-patchelf-check');
      fs.copyFileSync(binaryPath, patchedCopy);
      try {
        applyPatchelf(patchedCopy);
        patchelfVerified = verifyInterpreter(patchedCopy);
      } catch (e) {
        // patchelf is a static candidate check; absence/failure is recorded for review.
        patchelfVerified = false;
      }

      const candidateMeta = {
        version,
        download_url: tarballUrl,
        sha256_tar: sha256Tar,
        integrity: expectedIntegrity,
        patchelf_verified: patchelfVerified,
        source_repo: 'anomalyco/opencode',
        upstream_package: UPSTREAM_PACKAGE,
        detected_date: getTokyoDate(),
        status: 'pending_device_verification',
      };
      console.log(JSON.stringify(candidateMeta, null, 2));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
