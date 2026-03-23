/**
 * When enabled, saving a section draft bumps `project_sections.draft_revision` and removes
 * open suggestions tied to an older revision. Applied/ignored rows are kept.
 * Default: **on**. Set ANVIL_DRAFT_STALE_FEEDBACK=0 or false to disable (legacy: no bump / no delete).
 */
function staleFeedbackEnabled() {
  const v = process.env.ANVIL_DRAFT_STALE_FEEDBACK;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return true;
}

module.exports = { staleFeedbackEnabled };
