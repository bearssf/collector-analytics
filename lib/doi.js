/**
 * Optional DOI field: normalize user input and build https://doi.org/… resolver URLs.
 */

const MAX_LEN = 500;

function normalizeDoi(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:\s*/i, '').trim();
  s = s.replace(/\s+/g, '');
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
  return s || null;
}

/** @returns {string|null} */
function doiLandingPageUrl(doi) {
  const d = normalizeDoi(doi);
  if (!d) return null;
  return 'https://doi.org/' + encodeURIComponent(d).replace(/%2F/g, '/');
}

module.exports = { normalizeDoi, doiLandingPageUrl, MAX_DOI_LEN: MAX_LEN };
