/** Categories for Anvil feedback rows (logic / evidence / citations / APA-style formatting). */
const FEEDBACK_CATEGORIES = ['logic', 'evidence', 'citations', 'format'];

/** Stored as suggestion_status in SQL; exposed as status in JSON. */
const FEEDBACK_STATUSES = ['open', 'applied', 'ignored'];

function isValidCategory(c) {
  return FEEDBACK_CATEGORIES.includes(String(c || '').toLowerCase());
}

function isValidStatus(s) {
  return FEEDBACK_STATUSES.includes(String(s || '').toLowerCase());
}

function normalizeCategory(c) {
  const x = String(c || '').toLowerCase();
  return isValidCategory(x) ? x : null;
}

function rowToSuggestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    sectionId: row.section_id,
    category: row.category,
    body: row.body,
    status: row.suggestion_status,
    anchorJson: row.anchor_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  isValidCategory,
  isValidStatus,
  normalizeCategory,
  rowToSuggestion,
};
