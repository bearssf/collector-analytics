const sql = require('mssql');
const fs = require('fs');
const path = require('path');

const PURPOSES = [
  'Dissertation',
  'Academic Publication',
  'Thesis',
  'Essay',
  'Report',
  'Conference Document',
  'Other',
];

const CITATION_STYLES = ['APA', 'MLA', 'Chicago', 'Turabian', 'IEEE'];

let templatesCache = null;
function loadTemplates() {
  if (templatesCache) return templatesCache;
  const fp = path.join(__dirname, '..', 'data', 'project-templates.json');
  const raw = fs.readFileSync(fp, 'utf8');
  templatesCache = JSON.parse(raw);
  return templatesCache;
}

async function listProjects(getPool, userId) {
  const p = await getPool();
  const r = await p
    .request()
    .input('user_id', sql.Int, userId)
    .query(
      `SELECT id, name, purpose, status, citation_style, template_key, created_at, updated_at, started_at, completed_at
       FROM projects WHERE user_id = @user_id ORDER BY updated_at DESC`
    );
  return r.recordset;
}

async function getProjectBundle(getPool, projectId, userId) {
  const p = await getPool();
  const proj = await p
    .request()
    .input('id', sql.Int, projectId)
    .input('user_id', sql.Int, userId)
    .query(`SELECT * FROM projects WHERE id = @id AND user_id = @user_id`);
  if (!proj.recordset[0]) return null;
  const secs = await p
    .request()
    .input('project_id', sql.Int, projectId)
    .query(
      `SELECT id, project_id, sort_order, title, slug, status, progress_percent, created_at, updated_at
       FROM project_sections WHERE project_id = @project_id ORDER BY sort_order`
    );
  const cnt = await p
    .request()
    .input('project_id', sql.Int, projectId)
    .query(`SELECT COUNT(*) AS n FROM sources WHERE project_id = @project_id`);
  return {
    project: proj.recordset[0],
    sections: secs.recordset,
    sourceCount: cnt.recordset[0].n,
  };
}

/**
 * @returns {Promise<{ ok: true, bundle: object } | { ok: false, status: number, error: string, allowed?: string[] }>}
 */
async function createProject(getPool, userId, body) {
  const { name, purpose, citationStyle, templateKey } = body || {};
  const tpl = loadTemplates();
  if (!name || !String(name).trim()) {
    return { ok: false, status: 400, error: 'name is required' };
  }
  if (!purpose || !PURPOSES.includes(purpose)) {
    return { ok: false, status: 400, error: 'invalid purpose', allowed: PURPOSES };
  }
  if (!citationStyle || !CITATION_STYLES.includes(citationStyle)) {
    return { ok: false, status: 400, error: 'invalid citationStyle', allowed: CITATION_STYLES };
  }
  if (!templateKey || !tpl[templateKey]) {
    return { ok: false, status: 400, error: 'invalid templateKey' };
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  let newProjectId;
  await transaction.begin();
  try {
    const ins = await new sql.Request(transaction)
      .input('user_id', sql.Int, userId)
      .input('name', sql.NVarChar(255), String(name).trim())
      .input('purpose', sql.NVarChar(80), purpose)
      .input('citation_style', sql.NVarChar(40), citationStyle)
      .input('template_key', sql.NVarChar(80), templateKey)
      .input('status', sql.NVarChar(40), 'active')
      .query(`
        INSERT INTO projects (user_id, name, purpose, citation_style, template_key, status, started_at, updated_at)
        OUTPUT INSERTED.id
        VALUES (@user_id, @name, @purpose, @citation_style, @template_key, @status, GETDATE(), GETDATE())
      `);
    newProjectId = ins.recordset[0].id;
    const sections = tpl[templateKey].sections;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      await new sql.Request(transaction)
        .input('project_id', sql.Int, newProjectId)
        .input('sort_order', sql.Int, i)
        .input('title', sql.NVarChar(255), s.title)
        .input('slug', sql.NVarChar(80), s.slug || null)
        .query(`
          INSERT INTO project_sections (project_id, sort_order, title, slug, updated_at)
          VALUES (@project_id, @sort_order, @title, @slug, GETDATE())
        `);
    }
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }

  const bundle = await getProjectBundle(getPool, newProjectId, userId);
  return { ok: true, bundle };
}

module.exports = {
  PURPOSES,
  CITATION_STYLES,
  loadTemplates,
  listProjects,
  getProjectBundle,
  createProject,
};
