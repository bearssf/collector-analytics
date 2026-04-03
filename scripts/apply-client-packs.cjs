#!/usr/bin/env node
/**
 * Merges locales/packs/{code}.json into locales/{code}.json
 * (sectionLabels + client.anvil + client.crucible + client.billing).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCALES = ['zh-CN', 'hi', 'es', 'fr', 'pt', 'bn', 'ru', 'ur'];

for (const code of LOCALES) {
  const packPath = path.join(ROOT, 'locales', 'packs', `${code}.json`);
  if (!fs.existsSync(packPath)) {
    console.warn('skip (no pack):', code);
    continue;
  }
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const localePath = path.join(ROOT, 'locales', `${code}.json`);
  const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'));
  locale.sectionLabels = pack.sectionLabels;
  locale.client = locale.client || {};
  locale.client.anvil = pack.anvil;
  locale.client.crucible = pack.crucible;
  locale.client.billing = pack.billing;
  fs.writeFileSync(localePath, JSON.stringify(locale, null, 2) + '\n');
  console.log('applied', code);
}
