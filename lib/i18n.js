/**
 * UI i18n: locale bundles under /locales, fallback to English.
 */
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const COOKIE_NAME = 'af_locale';

/** BCP 47 codes supported in the UI */
const SUPPORTED_LOCALES = ['en', 'zh-CN', 'hi', 'es', 'ar', 'fr', 'pt', 'bn', 'ru', 'ur'];

const LOCALE_LABELS = {
  en: 'English',
  'zh-CN': 'Mandarin Chinese',
  hi: 'Hindi',
  es: 'Spanish',
  ar: 'Standard Arabic',
  fr: 'French',
  pt: 'Portuguese',
  bn: 'Bengali',
  ru: 'Russian',
  ur: 'Urdu',
};

/** Dot paths in locale bundles for language names (used by localeOptionsForSelect). */
const LOCALE_LABEL_KEYS = {
  en: 'localeLabels.en',
  'zh-CN': 'localeLabels.zhCN',
  hi: 'localeLabels.hi',
  es: 'localeLabels.es',
  ar: 'localeLabels.ar',
  fr: 'localeLabels.fr',
  pt: 'localeLabels.pt',
  bn: 'localeLabels.bn',
  ru: 'localeLabels.ru',
  ur: 'localeLabels.ur',
};

/** Stripe.js supported locales (https://stripe.com/docs/js/appendix/supported_locales) */
const STRIPE_LOCALE_MAP = {
  en: 'en',
  'zh-CN': 'zh',
  hi: 'en',
  es: 'es',
  ar: 'ar',
  fr: 'fr',
  pt: 'pt-BR',
  bn: 'en',
  ru: 'ru',
  ur: 'en',
};

const RTL_LOCALES = new Set(['ar', 'ur']);

let bundles = null;

function deepMerge(target, ...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of Object.keys(src)) {
      if (
        src[k] &&
        typeof src[k] === 'object' &&
        !Array.isArray(src[k]) &&
        target[k] &&
        typeof target[k] === 'object' &&
        !Array.isArray(target[k])
      ) {
        deepMerge(target[k], src[k]);
      } else {
        target[k] = src[k];
      }
    }
  }
  return target;
}

function loadBundles() {
  if (bundles) return bundles;
  const enPath = path.join(LOCALES_DIR, 'en.json');
  const base = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  bundles = { en: base };
  for (const code of SUPPORTED_LOCALES) {
    if (code === 'en') continue;
    const p = path.join(LOCALES_DIR, `${code}.json`);
    if (fs.existsSync(p)) {
      const overlay = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Clone base first — deepMerge({}, base, overlay) would alias nested objects from
      // `base` and mutate English when merging overlays (see locale bundle corruption bug).
      bundles[code] = deepMerge(JSON.parse(JSON.stringify(base)), overlay);
    } else {
      // Deep clone so missing overlay files do not share the en object reference.
      bundles[code] = JSON.parse(JSON.stringify(base));
    }
  }
  return bundles;
}

function normalizeLocale(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/_/g, '-');
  if (!s) return 'en';
  const lower = s.toLowerCase();
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zhcn') return 'zh-CN';
  for (const code of SUPPORTED_LOCALES) {
    if (code.toLowerCase() === lower) return code;
  }
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('pt')) return 'pt';
  return 'en';
}

function getNested(obj, keyPath) {
  if (!obj || !keyPath) return undefined;
  const parts = String(keyPath).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} locale
 * @param {string} key dot path e.g. account.title
 * @param {Record<string, string | number>} [vars]
 */
function t(locale, key, vars) {
  const loc = normalizeLocale(locale);
  const b = loadBundles();
  const bundle = b[loc] || b.en;
  let str = getNested(bundle, key);
  if (str == null || str === '') str = getNested(b.en, key);
  if (str == null) return key;
  str = String(str);
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(escapeHtml(String(v)));
    }
  }
  return str;
}

function readCookie(req, name) {
  const h = req.headers && req.headers.cookie;
  if (!h || !name) return null;
  const parts = h.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    try {
      return decodeURIComponent(p.slice(idx + 1).trim());
    } catch {
      return p.slice(idx + 1).trim();
    }
  }
  return null;
}

function setLocaleCookie(res, locale) {
  const loc = normalizeLocale(locale);
  const secure = process.env.NODE_ENV === 'production';
  let c = `${COOKIE_NAME}=${encodeURIComponent(loc)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  if (secure) c += '; Secure';
  res.append('Set-Cookie', c);
}

function textDirection(locale) {
  const loc = normalizeLocale(locale);
  const base = loc.split('-')[0];
  return RTL_LOCALES.has(loc) || RTL_LOCALES.has(base) ? 'rtl' : 'ltr';
}

function htmlLangAttr(locale) {
  const loc = normalizeLocale(locale);
  return loc;
}

function stripeLocale(locale) {
  const loc = normalizeLocale(locale);
  return STRIPE_LOCALE_MAP[loc] || 'en';
}

/** Human-readable language name for AI prompts */
function languageNameForAi(locale) {
  const loc = normalizeLocale(locale);
  return LOCALE_LABELS[loc] || 'English';
}

function localeOptionsForSelect(locale) {
  const loc = normalizeLocale(locale);
  return SUPPORTED_LOCALES.map((id) => ({
    id,
    label: t(loc, LOCALE_LABEL_KEYS[id] || 'localeLabels.en'),
  }));
}

/**
 * Express middleware: req.locale, res.locals.t, htmlLang, textDir, stripeLocale, i18nJson for client
 */
function attachLocaleMiddleware() {
  loadBundles();
  return function attachLocale(req, res, next) {
    let locale = 'en';
    if (req.session && req.session.locale) {
      locale = normalizeLocale(req.session.locale);
    } else {
      const c = readCookie(req, COOKIE_NAME);
      if (c) locale = normalizeLocale(c);
    }
    req.locale = locale;
    req.languageNameForAi = languageNameForAi(locale);
    res.locals.locale = locale;
    res.locals.t = (key, vars) => t(locale, key, vars);
    res.locals.htmlLang = htmlLangAttr(locale);
    res.locals.textDir = textDirection(locale);
    res.locals.stripeLocale = stripeLocale(locale);
    res.locals.localeOptions = localeOptionsForSelect(locale);
    res.locals.languageNameForAi = languageNameForAi(locale);
    try {
      const b = loadBundles();
      const flatClient = {
        anvil: getNested(b[locale] || b.en, 'client.anvil') || {},
        crucible: getNested(b[locale] || b.en, 'client.crucible') || {},
        common: getNested(b[locale] || b.en, 'client.common') || {},
        account: getNested(b[locale] || b.en, 'client.account') || {},
        billing: getNested(b[locale] || b.en, 'client.billing') || {},
        dashboard: getNested(b[locale] || b.en, 'client.dashboard') || {},
        training: getNested(b[locale] || b.en, 'client.training') || {},
      };
      res.locals.i18nClientJson = JSON.stringify(flatClient).replace(/</g, '\\u003c');
    } catch {
      res.locals.i18nClientJson = '{}';
    }
    next();
  };
}

function reloadBundles() {
  bundles = null;
  return loadBundles();
}

module.exports = {
  SUPPORTED_LOCALES,
  LOCALE_LABELS,
  COOKIE_NAME,
  normalizeLocale,
  t,
  loadBundles,
  reloadBundles,
  readCookie,
  setLocaleCookie,
  textDirection,
  htmlLangAttr,
  stripeLocale,
  languageNameForAi,
  localeOptionsForSelect,
  attachLocaleMiddleware,
};
