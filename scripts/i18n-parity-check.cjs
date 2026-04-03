#!/usr/bin/env node
/**
 * Report leaf keys under sectionLabels + client.{anvil,crucible,billing}
 * that are missing in a locale file vs en.json (same structure).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8'));

function getNested(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function flattenLeaves(root, prefix) {
  const out = [];
  function walk(o, p) {
    if (o === null || o === undefined) return;
    if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') {
      out.push(p);
      return;
    }
    if (Array.isArray(o)) {
      out.push(p);
      return;
    }
    if (typeof o === 'object') {
      const ks = Object.keys(o);
      if (ks.length === 0) out.push(p);
      for (const k of ks) walk(o[k], p ? `${p}.${k}` : k);
    }
  }
  walk(root, prefix);
  return out;
}

const allPaths = [
  ...flattenLeaves(en.sectionLabels, 'sectionLabels'),
  ...flattenLeaves(en.client.anvil, 'client.anvil'),
  ...flattenLeaves(en.client.crucible, 'client.crucible'),
  ...flattenLeaves(en.client.billing, 'client.billing'),
];

const LOCALES = ['zh-CN', 'hi', 'es', 'ar', 'fr', 'pt', 'bn', 'ru', 'ur'];

for (const code of LOCALES) {
  const localePath = path.join(ROOT, 'locales', `${code}.json`);
  const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'));
  const missing = [];
  const sameAsEn = [];
  for (const dotPath of allPaths) {
    const vEn = getNested(en, dotPath);
    const vLoc = getNested(locale, dotPath);
    if (vLoc === undefined) missing.push(dotPath);
    else if (typeof vEn === 'string' && typeof vLoc === 'string' && vEn === vLoc) sameAsEn.push(dotPath);
  }
  console.log(`\n=== ${code} ===`);
  console.log('missing:', missing.length);
  if (missing.length && missing.length <= 40) console.log(missing.join('\n'));
  else if (missing.length) console.log(missing.slice(0, 30).join('\n'), '...');
  console.log('same as en (possible untranslated):', sameAsEn.length);
}
