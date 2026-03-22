const sql = require('mssql');
const { normalizeCategory, rowToSuggestion } = require('./anvilFeedback');

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
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

/**
 * Insert validated suggestion rows for a section. Skips invalid category/body pairs.
 * @param {() => Promise<import('mssql').ConnectionPool>} getPool
 * @param {number} projectId
 * @param {number} sectionId
 * @param {{ category: string, body: string, anchorJson?: string|null }[]} items
 */
async function insertAnvilSuggestions(getPool, projectId, sectionId, items) {
  const created = [];
  const p = await getPool();
  for (const raw of items) {
    const cat = normalizeCategory(raw.category);
    const text = raw.body != null ? String(raw.body).trim() : '';
    if (!cat || !text) continue;
    const anchorJson = raw.anchorJson != null ? String(raw.anchorJson).slice(0, 500) : null;
    const ins = await p
      .request()
      .input('project_id', sql.Int, projectId)
      .input('section_id', sql.Int, sectionId)
      .input('category', sql.NVarChar(20), cat)
      .input('body', sql.NVarChar(sql.MAX), text)
      .input('anchor_json', sql.NVarChar(500), anchorJson)
      .query(`
        INSERT INTO anvil_suggestions (project_id, section_id, category, body, anchor_json, updated_at)
        OUTPUT INSERTED.id
        VALUES (@project_id, @section_id, @category, @body, @anchor_json, GETDATE())
      `);
    const newId = ins.recordset[0].id;
    const row = await p
      .request()
      .input('id', sql.Int, newId)
      .query(
        `SELECT id, project_id, section_id, category, body, suggestion_status, anchor_json, created_at, updated_at
         FROM anvil_suggestions WHERE id = @id`
      );
    created.push(mapRow(row.recordset[0]));
  }
  return created;
}

module.exports = { insertAnvilSuggestions };
