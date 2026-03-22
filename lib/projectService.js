const sql = require('mssql');
const fs = require('fs');
const path = require('path');

const PURPOSES = [
  'Academic Assignment',
  'Academic Publication',
  'Conference',
  'Dissertation/Thesis',
  'Other',
];

/** Display order for Forge / project settings template dropdown (keys in project-templates.json). */
const TEMPLATE_KEYS_FOR_FORM = [
  'academic-publication',
  'essay',
  'conference-proceeding',
  'dissertation',
  'literature-review',
  'persuasive-speech',
  'scientific-report',
  'thesis',
  'other',
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

function templateOptionsForForm() {
  const tpl = loadTemplates();
  return TEMPLATE_KEYS_FOR_FORM.filter((k) => tpl[k] && !tpl[k].deprecated).map((k) => ({
    key: k,
    label: tpl[k].label,
  }));
}

function slugFromTitle(title, index) {
  const raw = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return raw || `section-${index}`;
}

/**
 * @param {object} body - req.body from urlencoded (arrays for repeated fields)
 * @returns {{ title: string, percent: number }[]}
 */
function parseOtherSectionsFromBody(body) {
  let titles = body.otherSectionTitle;
  let pcts = body.otherSectionPercent;
  if (titles == null && pcts == null) return [];
  if (!Array.isArray(titles)) titles = titles != null ? [titles] : [];
  if (!Array.isArray(pcts)) pcts = pcts != null ? [pcts] : [];
  const n = Math.max(titles.length, pcts.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = String(titles[i] != null ? titles[i] : '').trim();
    const p = parseInt(pcts[i], 10);
    if (!t && (Number.isNaN(p) || p === 0)) continue;
    out.push({
      title: t,
      percent: Number.isNaN(p) ? 0 : Math.min(100, Math.max(0, p)),
    });
  }
  return out;
}

function validateOtherSections(sections) {
  if (!sections.length || sections.length > 15) {
    return {
      ok: false,
      error: "Since you're building a custom template, please enter the sections for your document.",
      noticeStyle: true,
    };
  }
  for (const s of sections) {
    if (!s.title) {
      return { ok: false, error: 'Each section needs a name.' };
    }
  }
  const sum = sections.reduce((a, s) => a + s.percent, 0);
  if (sum !== 100) {
    return { ok: false, error: 'Section percentages must total 100%.' };
  }
  return { ok: true };
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
      `SELECT id, project_id, sort_order, title, slug, status, progress_percent, body, created_at, updated_at
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
  const purposeOtherRaw = body && body.purposeOther != null ? String(body.purposeOther).trim() : '';
  const purposeOther = purposeOtherRaw ? purposeOtherRaw.slice(0, 500) : null;

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

  let sectionsToInsert = tpl[templateKey].sections;
  if (templateKey === 'other') {
    const custom = parseOtherSectionsFromBody(body);
    const v = validateOtherSections(custom);
    if (!v.ok) {
      return {
        ok: false,
        status: 400,
        error: v.error,
        ...(v.noticeStyle ? { errorNotice: true } : {}),
      };
    }
    sectionsToInsert = custom.map((s, i) => ({
      title: s.title,
      slug: slugFromTitle(s.title, i),
      progress_percent: s.percent,
    }));
  } else {
    sectionsToInsert = sectionsToInsert.map((s) => ({
      ...s,
      progress_percent: 0,
    }));
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
      .input('purpose_other', sql.NVarChar(500), purpose === 'Other' ? purposeOther : null)
      .input('citation_style', sql.NVarChar(40), citationStyle)
      .input('template_key', sql.NVarChar(80), templateKey)
      .input('status', sql.NVarChar(40), 'active')
      .query(`
        INSERT INTO projects (user_id, name, purpose, purpose_other, citation_style, template_key, status, started_at, updated_at)
        OUTPUT INSERTED.id
        VALUES (@user_id, @name, @purpose, @purpose_other, @citation_style, @template_key, @status, GETDATE(), GETDATE())
      `);
    newProjectId = ins.recordset[0].id;
    for (let i = 0; i < sectionsToInsert.length; i++) {
      const s = sectionsToInsert[i];
      const prog = s.progress_percent != null ? s.progress_percent : 0;
      await new sql.Request(transaction)
        .input('project_id', sql.Int, newProjectId)
        .input('sort_order', sql.Int, i)
        .input('title', sql.NVarChar(255), s.title)
        .input('slug', sql.NVarChar(80), s.slug || null)
        .input('progress_percent', sql.TinyInt, prog)
        .query(`
          INSERT INTO project_sections (project_id, sort_order, title, slug, progress_percent, updated_at)
          VALUES (@project_id, @sort_order, @title, @slug, @progress_percent, GETDATE())
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

/**
 * @returns {Promise<{ ok: true, bundle: object } | { ok: false, status: number, error: string, allowed?: string[] }>}
 */
async function updateProjectSettings(getPool, userId, projectId, body) {
  const bundle = await getProjectBundle(getPool, projectId, userId);
  if (!bundle) return { ok: false, status: 404, error: 'Not found' };

  if (body && body.otherSectionsJson != null && typeof body.otherSectionsJson === 'string') {
    try {
      body = { ...body, otherSections: JSON.parse(body.otherSectionsJson) };
    } catch (e) {
      return { ok: false, status: 400, error: 'Invalid sections data.' };
    }
  }

  const name = body.name != null ? String(body.name).trim() : undefined;
  const purpose = body.purpose;
  const citationStyle = body.citationStyle;
  const purposeOtherRaw = body.purposeOther != null ? String(body.purposeOther).trim() : undefined;
  const purposeOther = purposeOtherRaw !== undefined ? purposeOtherRaw.slice(0, 500) || null : undefined;

  if (name !== undefined && !name) {
    return { ok: false, status: 400, error: 'name is required' };
  }
  if (purpose !== undefined && !PURPOSES.includes(purpose)) {
    return { ok: false, status: 400, error: 'invalid purpose', allowed: PURPOSES };
  }
  if (citationStyle !== undefined && !CITATION_STYLES.includes(citationStyle)) {
    return { ok: false, status: 400, error: 'invalid citationStyle', allowed: CITATION_STYLES };
  }

  const pool = await getPool();
  const proj = bundle.project;

  const updates = [];
  const req = (await pool.request())
    .input('id', sql.Int, projectId)
    .input('user_id', sql.Int, userId);

  if (name !== undefined) {
    updates.push('name = @name');
    req.input('name', sql.NVarChar(255), name);
  }
  if (purpose !== undefined) {
    updates.push('purpose = @purpose');
    req.input('purpose', sql.NVarChar(80), purpose);
    if (purpose === 'Other' && purposeOther !== undefined) {
      updates.push('purpose_other = @purpose_other');
      req.input('purpose_other', sql.NVarChar(500), purposeOther);
    } else if (purpose !== 'Other') {
      updates.push('purpose_other = NULL');
    }
  } else if (purposeOther !== undefined && proj.purpose === 'Other') {
    updates.push('purpose_other = @purpose_other');
    req.input('purpose_other', sql.NVarChar(500), purposeOther);
  }
  if (citationStyle !== undefined) {
    updates.push('citation_style = @citation_style');
    req.input('citation_style', sql.NVarChar(40), citationStyle);
  }

  if (updates.length === 0 && !(bundle.project.template_key === 'other' && body.otherSections != null)) {
    return { ok: false, status: 400, error: 'No valid fields to update' };
  }

  if (bundle.project.template_key === 'other' && body.otherSections != null) {
    const arr = Array.isArray(body.otherSections) ? body.otherSections : [];
    if (arr.length !== bundle.sections.length) {
      return { ok: false, status: 400, error: 'Section count does not match this project.' };
    }
    const parsed = arr.map((row) => {
      const id = parseInt(row.id, 10);
      const title = String(row.title || '').trim();
      const pct = parseInt(row.progressPercent, 10);
      return {
        id,
        title,
        percent: Number.isNaN(pct) ? 0 : Math.min(100, Math.max(0, pct)),
      };
    });
    const ids = new Set(bundle.sections.map((s) => s.id));
    for (const pRow of parsed) {
      if (!ids.has(pRow.id)) {
        return { ok: false, status: 400, error: 'Invalid section id.' };
      }
    }
    const sum = parsed.reduce((a, s) => a + s.percent, 0);
    if (sum !== 100) {
      return { ok: false, status: 400, error: 'Section percentages must total 100%.' };
    }
    for (const pRow of parsed) {
      if (!pRow.title) {
        return { ok: false, status: 400, error: 'Each section needs a name.' };
      }
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const r0 = new sql.Request(transaction)
        .input('id', sql.Int, projectId)
        .input('user_id', sql.Int, userId);
      let projSql = 'UPDATE projects SET updated_at = GETDATE()';
      if (name !== undefined) {
        projSql += ', name = @name';
        r0.input('name', sql.NVarChar(255), name);
      }
      if (purpose !== undefined) {
        projSql += ', purpose = @purpose';
        r0.input('purpose', sql.NVarChar(80), purpose);
        if (purpose === 'Other' && purposeOther !== undefined) {
          projSql += ', purpose_other = @purpose_other';
          r0.input('purpose_other', sql.NVarChar(500), purposeOther);
        } else if (purpose !== 'Other') {
          projSql += ', purpose_other = NULL';
        }
      } else if (purposeOther !== undefined && proj.purpose === 'Other') {
        projSql += ', purpose_other = @purpose_other';
        r0.input('purpose_other', sql.NVarChar(500), purposeOther);
      }
      if (citationStyle !== undefined) {
        projSql += ', citation_style = @citation_style';
        r0.input('citation_style', sql.NVarChar(40), citationStyle);
      }
      projSql += ' WHERE id = @id AND user_id = @user_id';
      await r0.query(projSql);

      for (const row of parsed) {
        await new sql.Request(transaction)
          .input('sid', sql.Int, row.id)
          .input('title', sql.NVarChar(255), row.title)
          .input('progress_percent', sql.TinyInt, row.percent)
          .query(
            `UPDATE project_sections SET title = @title, progress_percent = @progress_percent, updated_at = GETDATE() WHERE id = @sid`
          );
      }
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
    const out = await getProjectBundle(getPool, projectId, userId);
    return { ok: true, bundle: out };
  }

  if (updates.length === 0) {
    return { ok: false, status: 400, error: 'No valid fields to update' };
  }
  updates.push('updated_at = GETDATE()');
  const sqlText = `UPDATE projects SET ${updates.join(', ')} WHERE id = @id AND user_id = @user_id`;
  const r = await req.query(sqlText);
  if (r.rowsAffected[0] === 0) return { ok: false, status: 404, error: 'Not found' };
  const out = await getProjectBundle(getPool, projectId, userId);
  return { ok: true, bundle: out };
}

/**
 * Permanently delete a project and related rows. `anvil_suggestions` uses ON DELETE NO ACTION to `projects`, so it is removed first.
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
async function deleteProject(getPool, userId, projectId) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const req = new sql.Request(transaction);
    const proj = await req
      .input('id', sql.Int, projectId)
      .input('user_id', sql.Int, userId)
      .query('SELECT id FROM projects WHERE id = @id AND user_id = @user_id');
    if (!proj.recordset[0]) {
      await transaction.rollback();
      return { ok: false, status: 404, error: 'Not found' };
    }
    await new sql.Request(transaction)
      .input('project_id', sql.Int, projectId)
      .query('DELETE FROM anvil_suggestions WHERE project_id = @project_id');
    const del = await new sql.Request(transaction)
      .input('id', sql.Int, projectId)
      .input('user_id', sql.Int, userId)
      .query('DELETE FROM projects WHERE id = @id AND user_id = @user_id');
    if (del.rowsAffected[0] === 0) {
      await transaction.rollback();
      return { ok: false, status: 404, error: 'Not found' };
    }
    await transaction.commit();
    return { ok: true };
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

module.exports = {
  PURPOSES,
  CITATION_STYLES,
  loadTemplates,
  templateOptionsForForm,
  listProjects,
  getProjectBundle,
  createProject,
  updateProjectSettings,
  deleteProject,
};
