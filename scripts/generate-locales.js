#!/usr/bin/env node
/**
 * Builds locales/<code>.json from locales/en.json using Google Translate (gtx, no API key).
 * Run from repo root: node scripts/generate-locales.js
 * Requires network. Re-run after large edits to en.json.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const EN_PATH = path.join(ROOT, 'locales', 'en.json');

/** Google Translate `tl` parameter per app locale code */
const GOOGLE_TL = {
  'zh-CN': 'zh-CN',
  hi: 'hi',
  es: 'es',
  ar: 'ar',
  fr: 'fr',
  pt: 'pt',
  bn: 'bn',
  ru: 'ru',
  ur: 'ur',
};

const DELAY_MS = 55;
const MAX_Q_LEN = 1800;
const cache = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function maskPlaceholders(s) {
  const parts = [];
  const masked = String(s).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m) => {
    const i = parts.length;
    parts.push(m);
    return `__AF_VAR_${i}__`;
  });
  return { masked, parts };
}

function unmaskPlaceholders(translated, parts) {
  let out = String(translated);
  for (let i = 0; i < parts.length; i++) {
    const token = `__AF_VAR_${i}__`;
    out = out.split(token).join(parts[i]);
    out = out.split(token.toLowerCase()).join(parts[i]);
  }
  return out;
}

const REQUEST_MS = 25000;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve(data));
      }
    );
    req.setTimeout(REQUEST_MS, () => {
      req.destroy(new Error(`Translation request timed out after ${REQUEST_MS}ms`));
    });
    req.on('error', reject);
  });
}

async function withRetries(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

function parseGoogleJson(raw) {
  const data = JSON.parse(raw);
  if (!data[0]) return '';
  return data[0].map((seg) => (seg && seg[0] ? String(seg[0]) : '')).join('');
}

async function googleTranslateSegment(text, tl) {
  const q = encodeURIComponent(text);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${tl}&dt=t&q=${q}`;
  const body = await withRetries(() => fetchUrl(url));
  const trimmed = body.trim();
  if (trimmed.startsWith('<') || !trimmed.startsWith('[')) {
    throw new Error(
      'Translation service returned non-JSON (rate limit or block). Retry later or run from a different network.'
    );
  }
  return parseGoogleJson(body);
}

async function translateText(raw, tl) {
  const text = String(raw);
  if (!text.trim()) return text;
  const key = tl + '::' + text;
  if (cache.has(key)) return cache.get(key);

  const { masked, parts } = maskPlaceholders(text);
  const toSend = masked;

  async function runSegment(s) {
    await sleep(DELAY_MS);
    return googleTranslateSegment(s, tl);
  }

  if (parts.length > 0 || toSend.length <= MAX_Q_LEN) {
    let tr = await runSegment(toSend);
    tr = unmaskPlaceholders(tr, parts);
    cache.set(key, tr);
    return tr;
  }

  const chunks = [];
  let rest = toSend;
  while (rest.length) {
    let chunk = rest.slice(0, MAX_Q_LEN);
    let advance = chunk.length;
    if (rest.length > MAX_Q_LEN) {
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > 400) {
        chunk = rest.slice(0, lastSpace);
        advance = lastSpace + 1;
      }
    }
    rest = rest.slice(advance);
    chunks.push(await runSegment(chunk));
  }
  const merged = chunks.join('');
  cache.set(key, merged);
  return merged;
}

async function translateValue(val, tl) {
  if (typeof val === 'string') {
    return translateText(val, tl);
  }
  if (Array.isArray(val)) {
    const out = [];
    for (const item of val) {
      out.push(await translateValue(item, tl));
    }
    return out;
  }
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) {
      out[k] = await translateValue(val[k], tl);
    }
    return out;
  }
  return val;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let codes = Object.keys(GOOGLE_TL);
  if (argv.length) {
    codes = argv.map((c) => c.trim()).filter(Boolean);
    for (const c of codes) {
      if (!GOOGLE_TL[c]) {
        console.error('Unknown locale code:', c, '- expected one of', Object.keys(GOOGLE_TL).join(', '));
        process.exit(1);
      }
    }
  }

  const en = JSON.parse(fs.readFileSync(EN_PATH, 'utf8'));
  for (const code of codes) {
    const tl = GOOGLE_TL[code];
    console.error('Translating', code, 'tl=' + tl, '...');
    cache.clear();
    const out = await translateValue(en, tl);
    const dest = path.join(ROOT, 'locales', `${code}.json`);
    fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.error('Wrote', dest);
  }
  console.error('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
