const { query } = require('./db');
const { normalizeCategory, rowToSuggestion } = require('./anvilFeedback');
const { staleFeedbackEnabled } = require('./anvilStaleFeedback');

function mapRow(r) {
  if (!r) return null;
  return rowToSuggestion({
    id: r.id,
    project_id: r.project_id,
    section_id: r.section_id,
    category: r.category,
    body: r.body,
    suggestion_status: r.suggestion_status,
    anchor_json: r.anchor_json,
    draft_revision_at_generation: r.draft_revision_at_generation,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

async function insertAnvilSuggestions(getPool, projectId, sectionId, items) {
  const created = [];
  let revAtInsert = 0;
  if (staleFeedbackEnabled()) {
    const revRes = await query(
      getPool,
      `SELECT draft_revision FROM project_sections WHERE id = @section_id`,
      { section_id: sectionId }
    );
    revAtInsert =
      revRes.recordset[0] && revRes.recordset[0].draft_revision != null
        ? Number(revRes.recordset[0].draft_revision)
        : 0;
  }
  for (const raw of items) {
    const cat = normalizeCategory(raw.category);
    const text = raw.body != null ? String(raw.body).trim() : '';
    if (!cat || !text) continue;
    const anchorJson = raw.anchorJson != null ? String(raw.anchorJson).slice(0, 500) : null;
    const baseParams = {
      project_id: projectId,
      section_id: sectionId,
      category: cat,
      body: text,
      anchor_json: anchorJson,
    };
    let ins;
    if (staleFeedbackEnabled()) {
      ins = await query(
        getPool,
        `INSERT INTO anvil_suggestions (project_id, section_id, category, body, anchor_json, draft_revision_at_generation, updated_at)
         VALUES (@project_id, @section_id, @category, @body, @anchor_json, @draft_rev_gen, NOW())`,
        { ...baseParams, draft_rev_gen: revAtInsert }
      );
    } else {
      ins = await query(
        getPool,
        `INSERT INTO anvil_suggestions (project_id, section_id, category, body, anchor_json, updated_at)
         VALUES (@project_id, @section_id, @category, @body, @anchor_json, NOW())`,
        baseParams
      );
    }
    const newId = ins.insertId;
    const row = await query(
      getPool,
      `SELECT id, project_id, section_id, category, body, suggestion_status, anchor_json, draft_revision_at_generation, created_at, updated_at
       FROM anvil_suggestions WHERE id = @id`,
      { id: newId }
    );
    created.push(mapRow(row.recordset[0]));
  }
  return created;
}

module.exports = { insertAnvilSuggestions };
