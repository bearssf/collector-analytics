'use strict';

/**
 * Mirrors client-side slug derivation (see i18n-bootstrap) and projectService.slugFromTitle.
 * Used to resolve sectionLabels when DB slug is empty but title matches a template (e.g. "Introduction").
 */
function deriveSlugFromTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * @param {{ title?: string, slug?: string | null }} sec
 * @param {(key: string, vars?: object) => string} t - res.locals.t
 * @returns {string}
 */
function localizedSectionTitle(sec, t) {
  const title = sec && sec.title != null ? String(sec.title) : '';
  let slug = sec && sec.slug != null ? String(sec.slug).trim() : '';
  if (!slug && title) {
    const d = deriveSlugFromTitle(title);
    if (d) slug = d;
  }
  if (!slug) return title;
  const key = 'sectionLabels.' + slug.replace(/-/g, '_');
  const out = t(key);
  if (!out || out === key) return title;
  return out;
}

module.exports = {
  deriveSlugFromTitle,
  localizedSectionTitle,
};
