#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { normalizeVersion, getTokyoDate } = require('../lib/version-utils');

const CANDIDATE_CONFIG_PATH = './config/opencode-candidate-version.json';
const VERIFIED_CONFIG_PATH = './config/opencode-verified-versions.json';
const PACKAGE_JSON_PATH = './package.json';

function main() {
  try {
    const rawVersion = process.argv[2];
    const confirmFlag = process.argv[3];
    if (!rawVersion) {
      console.error('Usage: promote-opencode-candidate.js <version> --confirm-device-verified');
      process.exit(1);
    }
    if (confirmFlag !== '--confirm-device-verified') {
      console.error('Error: --confirm-device-verified flag is required to prevent accidental promotion');
      console.error('Usage: promote-opencode-candidate.js <version> --confirm-device-verified');
      process.exit(1);
    }
    if (process.env.CI === 'true' && process.env.OPENCODE_PROMOTE_ALLOW_CI !== '1') {
      console.error('Error: Promotion from CI environment requires OPENCODE_PROMOTE_ALLOW_CI=1 to prevent accidental automation');
      console.error('This script should be run manually after device verification');
      process.exit(1);
    }
    const version = normalizeVersion(rawVersion);
    if (!fs.existsSync(CANDIDATE_CONFIG_PATH)) {
      console.error(`Error: Candidate config not found at ${CANDIDATE_CONFIG_PATH}`);
      console.error('Run scripts/prepare-opencode-candidate.js first to create a candidate');
      process.exit(1);
    }
    const candidateMeta = JSON.parse(fs.readFileSync(CANDIDATE_CONFIG_PATH, 'utf8'));
    if (!candidateMeta.version) {
      console.error('Error: Candidate config missing version');
      process.exit(1);
    }
    if (candidateMeta.version !== version) {
      console.error(`Error: Version mismatch. Candidate is ${candidateMeta.version}, but ${version} requested`);
      process.exit(1);
    }
    if (candidateMeta.status !== 'pending_device_verification') {
      console.error(`Error: Candidate status is '${candidateMeta.status}', expected 'pending_device_verification'`);
      process.exit(1);
    }
    const verifiedDate = getTokyoDate();
    const verifiedMeta = {
      version: candidateMeta.version,
      download_url: candidateMeta.download_url,
      sha256_tar: candidateMeta.sha256_tar,
      integrity: candidateMeta.integrity,
      patchelf_verified: candidateMeta.patchelf_verified,
      source_repo: candidateMeta.source_repo,
      upstream_package: candidateMeta.upstream_package,
      verified_date: verifiedDate,
      release_state: 'stable',
      notes: `Promoted via promote-opencode-candidate.js --confirm-device-verified on ${verifiedDate}. Patchelf interpreter static check recorded as ${candidateMeta.patchelf_verified ? 'verified' : 'not verified'}. Device/functional verification confirmed by the operator invoking this script with --confirm-device-verified.`,
    };
    fs.writeFileSync(VERIFIED_CONFIG_PATH, JSON.stringify(verifiedMeta, null, 2) + '\n');
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    packageJson.version = version;
    fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n');
    console.log(`✓ Promoted ${version} from candidate to verified`);
    console.log(`✓ Updated ${VERIFIED_CONFIG_PATH}`);
    console.log(`✓ Updated ${PACKAGE_JSON_PATH} version to ${version}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
