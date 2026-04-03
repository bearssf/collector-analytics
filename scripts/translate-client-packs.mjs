#!/usr/bin/env node
/**
 * Builds locales/packs/{code}.json from locales/packs/_en-template.json
 * using MyMemory translate API (free tier). Preserves {placeholders}.
 * Run: node scripts/translate-client-packs.mjs
 * Optional: node scripts/translate-client-packs.mjs --only es,fr
 */
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'locales', 'packs', '_en-template.json');
const CACHE_PATH = path.join(ROOT, 'locales', 'packs', '.translation-cache.json');

/** MyMemory langpair target codes */
const LANGPAIR = {
  'zh-CN': 'zh-CN',
  hi: 'hi',
  es: 'es',
  fr: 'fr',
  pt: 'pt',
  bn: 'bn',
  ru: 'ru',
  ur: 'ur',
};

/** Lingva path segment (https://lingva.ml/api/v1/en/{target}/...) */
const LINGVA_TARGET = {
  'zh-CN': 'zh',
  hi: 'hi',
  es: 'es',
  fr: 'fr',
  pt: 'pt',
  bn: 'bn',
  ru: 'ru',
  ur: 'ur',
};

const TARGETS_DEFAULT = Object.keys(LANGPAIR);

/** After MyMemory quota (429), skip it for the rest of this process. */
let skipMyMemory = false;

function flattenStrings(obj, prefix = '') {
  const out = {};
  function walk(o, p) {
    if (typeof o === 'string') {
      out[p] = o;
      return;
    }
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const k of Object.keys(o)) walk(o[k], p ? `${p}.${k}` : k);
    }
  }
  walk(obj, prefix);
  return out;
}

function unflattenToTemplate(flat, templateShape) {
  const clone = JSON.parse(JSON.stringify(templateShape));
  function setPath(root, dotPath, value) {
    const parts = dotPath.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!cur[k]) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  }
  for (const [dotPath, val] of Object.entries(flat)) {
    setPath(clone, dotPath, val);
  }
  return clone;
}

/** Slash in URL path breaks Lingva when encoded as %2F — hide before translate. */
const SLASH_TOKEN = '\uE000';

function protectSlashes(s) {
  return s.replace(/\//g, SLASH_TOKEN);
}

function restoreSlashes(s) {
  return s.split(SLASH_TOKEN).join('/');
}

function protectPlaceholders(s) {
  const parts = [];
  const out = s.replace(/\{[^}]+\}/g, (m) => {
    const i = parts.length;
    parts.push(m);
    return `⟦P${i}⟧`;
  });
  return { text: out, parts };
}

function restorePlaceholders(translated, parts) {
  let t = translated;
  parts.forEach((p, i) => {
    t = t.split(`⟦P${i}⟧`).join(p);
  });
  return t;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function translateViaLingva(protectedText, code) {
  const lv = LINGVA_TARGET[code];
  if (!lv) throw new Error(`No Lingva target for ${code}`);
  const seg = encodeURIComponent(protectedText);
  const url = `https://lingva.ml/api/v1/en/${lv}/${seg}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchJson(url);
      if (data.error || !data.translation) {
        throw new Error(data.error || 'Lingva returned no translation');
      }
      return data.translation;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function translateLine(enText, code) {
  const slashSafe = protectSlashes(enText);
  const { text: protectedText, parts } = protectPlaceholders(slashSafe);

  async function finish(raw) {
    return restoreSlashes(restorePlaceholders(raw, parts));
  }

  const useLingvaOnly = process.env.I18N_LINGVA_ONLY === '1';

  if (!useLingvaOnly && !skipMyMemory) {
    const mymemoryTarget = LANGPAIR[code];
    const q = encodeURIComponent(protectedText);
    const pair = encodeURIComponent(`en|${mymemoryTarget}`);
    const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=${pair}`;
    try {
      const data = await fetchJson(url);
      const txt = data.responseData?.translatedText;
      const quotaWarn =
        typeof txt === 'string' &&
        (txt.includes('MYMEMORY WARNING') || txt.includes('YOU USED ALL AVAILABLE FREE TRANSLATIONS'));
      if (data.responseStatus === 429 || quotaWarn) {
        skipMyMemory = true;
        console.warn('MyMemory unavailable; using Lingva for remaining strings in this run.');
      } else if (data.responseStatus === 200 && txt && !quotaWarn) {
        return finish(txt);
      }
    } catch {
      skipMyMemory = true;
      console.warn('MyMemory request failed; using Lingva for remaining strings in this run.');
    }
  }

  const raw = await translateViaLingva(protectedText, code);
  return finish(raw);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  let targets = TARGETS_DEFAULT;
  if (onlyArg) {
    targets = onlyArg
      .split('=')[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const templateShape = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const flatEn = flattenStrings(templateShape);
  const paths = Object.keys(flatEn).sort();
  const cache = loadCache();

  for (const code of targets) {
    const target = LANGPAIR[code];
    if (!target) {
      console.warn('Unknown locale', code);
      continue;
    }
    console.log('===', code, '===');
    const outFlat = { ...flatEn };
    let i = 0;
    for (const p of paths) {
      i++;
      const enText = flatEn[p];
      const cacheKey = `${code}::${enText}`;
      if (cache[cacheKey]) {
        outFlat[p] = cache[cacheKey];
        continue;
      }
      try {
        const translated = await translateLine(enText, code);
        outFlat[p] = translated;
        cache[cacheKey] = translated;
        if (i % 20 === 0) {
          saveCache(cache);
          console.log(`  ${i}/${paths.length}`);
        }
        await sleep(250);
      } catch (e) {
        console.error(`FAIL ${code} ${p}:`, e.message);
        saveCache(cache);
        process.exit(1);
      }
    }
    const pack = unflattenToTemplate(outFlat, templateShape);
    const outPath = path.join(ROOT, 'locales', 'packs', `${code}.json`);
    fs.writeFileSync(outPath, JSON.stringify(pack, null, 2) + '\n');
    saveCache(cache);
    console.log('wrote', outPath);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
