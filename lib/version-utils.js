'use strict';

function normalizeVersion(version) {
  return String(version).replace(/^v/, '');
}

function getTokyoDate() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

module.exports = { normalizeVersion, getTokyoDate };
