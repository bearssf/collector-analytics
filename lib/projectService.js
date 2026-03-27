const { query, withTransaction } = require('./db');
const fs = require('fs');
const path = require('path');
const { staleFeedbackEnabled } = require('./anvilStaleFeedback');

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
  'dissertation',
  'literature-review',
  'persuasive-speech',
  'scientific-report',
  'thesis',
  'other',
];

const CITATION_STYLES = ['APA', 'MLA', 'Chicago', 'Turabian', 'IEEE'];

const TEMPLATES_FILE = path.join(__dirname, '..', 'data', 'project-templates.json');

let templatesCache = null;
function loadTemplates() {
  if (templatesCache) return templatesCache;
  const raw = fs.readFileSync(TEMPLATES_FILE, 'utf8');
  templatesCache = JSON.parse(raw);
  return templatesCache;
}

function invalidateTemplatesCache() {
  templatesCache = null;
}

/** Integers ≥ 0 that sum to 100 (distributes remainder across first sections). */
function equalIntegerPercents(n) {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  const rem = 100 - base * n;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(base + (i < rem ? 1 : 0));
  }
  return out;
}

/**
 * Per-section document weight (must total 100). Falls back to an even split if percents missing or invalid.
 * @param {{ title: string, slug?: string, percent?: number }[]} sections
 * @returns {number[]}
 */
function normalizeTemplateSectionPercents(sections) {
  const n = sections.length;
  if (n === 0) return [];
  const parsed = sections.map((s) => {
    if (s == null || s.percent == null) return null;
    const p = parseFloat(String(s.percent));
    return Number.isNaN(p) ? null : Math.min(100, Math.max(0, Math.round(p * 100) / 100));
  });
  if (parsed.every((p) => p != null)) {
    const sum = parsed.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) < 0.01) return parsed;
  }
  return equalIntegerPercents(n);
}

function normalizeTemplatesForSave(tpl) {
  const out = {};
  for (const k of Object.keys(tpl)) {
    const t = tpl[k];
    if (!t || typeof t !== 'object') continue;
    const copy = {
      label: String(t.label || '').trim() || k,
      sections: [],
    };
    if (t.deprecated) copy.deprecated = true;
    if (t.projectedTotalWords != null && t.projectedTotalWords !== '') {
      const w = Math.round(Number(t.projectedTotalWords));
      if (Number.isFinite(w) && w >= 0 && w <= 500000) {
        copy.projectedTotalWords = w;
      }
    }
    if (k === 'other') {
      copy.sections = [];
      out[k] = copy;
      continue;
    }
    const sections = Array.isArray(t.sections) ? t.sections : [];
    const pcts = normalizeTemplateSectionPercents(sections);
    copy.sections = sections.map((s, i) => {
      const title = String((s && s.title) || '').trim() || `Section ${i + 1}`;
      let slug = s && s.slug != null ? String(s.slug).trim() : '';
      if (!slug) slug = slugFromTitle(title, i);
      return { title, slug, percent: pcts[i] };
    });
    out[k] = copy;
  }
  return out;
}

/**
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateTemplatesForSave(tpl) {
  if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) {
    return { ok: false, error: 'Templates must be a JSON object.' };
  }
  const keys = Object.keys(tpl);
  if (keys.length === 0) return { ok: false, error: 'No templates.' };
  for (const k of keys) {
    const t = tpl[k];
    if (!t || typeof t !== 'object') return { ok: false, error: `Invalid template: ${k}` };
    if (typeof t.label !== 'string' || !String(t.label).trim()) {
      return { ok: false, error: `Template "${k}" needs a label.` };
    }
    if (!Array.isArray(t.sections)) return { ok: false, error: `Template "${k}" needs a sections array.` };
    if (k === 'other') {
      if (t.sections.length !== 0) return { ok: false, error: 'Template "other" must have an empty sections array.' };
      continue;
    }
    const n = t.sections.length;
    if (n === 0) return { ok: false, error: `Template "${k}" needs at least one section.` };
    if (n > 40) return { ok: false, error: `Template "${k}": too many sections (max 40).` };
    for (let i = 0; i < n; i += 1) {
      const s = t.sections[i];
      if (!s || typeof s !== 'object') return { ok: false, error: `Template "${k}": invalid section ${i + 1}.` };
      if (typeof s.title !== 'string' || !String(s.title).trim()) {
        return { ok: false, error: `Template "${k}": section ${i + 1} needs a title.` };
      }
      if (s.slug != null && typeof s.slug !== 'string') {
        return { ok: false, error: `Template "${k}": invalid slug on section ${i + 1}.` };
      }
    }
    const rawPcts = t.sections.map((s) => {
      if (s == null || s.percent == null || String(s.percent).trim() === '') return null;
      const p = parseFloat(String(s.percent));
      return Number.isNaN(p) ? NaN : Math.min(100, Math.max(0, Math.round(p * 100) / 100));
    });
    const hasAny = rawPcts.some((p) => p != null && !Number.isNaN(p));
    const hasAll = rawPcts.every((p) => p != null && !Number.isNaN(p));
    if (hasAny && !hasAll) {
      return {
        ok: false,
        error: `Template "${k}": set a percent on every section, or leave them all blank for an even split.`,
      };
    }
    if (hasAll) {
      const sum = rawPcts.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) >= 0.01) {
        const sumLabel = Math.round(sum * 100) / 100;
        return {
          ok: false,
          error: `Template "${k}": section percentages must total 100% (currently ${sumLabel}%).`,
        };
      }
    }
    if (t.projectedTotalWords != null && t.projectedTotalWords !== '') {
      const w = Number(t.projectedTotalWords);
      if (!Number.isFinite(w) || w < 0 || w > 500000) {
        return { ok: false, error: `Template "${k}": projected total words must be between 0 and 500000.` };
      }
    }
  }
  if (!tpl.other) return { ok: false, error: 'Templates must include the "other" (custom) template.' };
  return { ok: true };
}

/**
 * Write normalized templates to disk (atomic write via temp file).
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function saveProjectTemplates(tpl) {
  const v = validateTemplatesForSave(tpl);
  if (!v.ok) return v;
  const normalized = normalizeTemplatesForSave(tpl);
  try {
    const tmp = `${TEMPLATES_FILE}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, TEMPLATES_FILE);
    invalidateTemplatesCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'Could not save templates file.' };
  }
}

/** Attach `templateMeta` for clients (Anvil progress: targets and document completion). */
function attachTemplateMeta(bundle) {
  if (!bundle || !bundle.project) return bundle;
  bundle.anvilStaleFeedbackEnabled = staleFeedbackEnabled();
  const tpl = loadTemplates();
  const key = bundle.project.template_key;
  if (!key || !tpl[key]) {
    bundle.templateMeta = null;
    return bundle;
  }
  const def = tpl[key];
  const total =
    def.projectedTotalWords != null ? Math.max(0, Math.round(Number(def.projectedTotalWords))) : null;
  bundle.templateMeta = {
    templateKey: key,
    templateLabel: def.label || key,
    projectedTotalWords: Number.isFinite(total) && total > 0 ? total : null,
  };
  bundle.anvilStaleFeedbackEnabled = staleFeedbackEnabled();
  return bundle;
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
 * @returns {{ title: string, percent: number, slug?: string }[]}
 */
function parseOtherSectionsFromBody(body) {
  let titles = body.otherSectionTitle;
  let pcts = body.otherSectionPercent;
  if (titles == null && pcts == null) return [];
  if (!Array.isArray(titles)) titles = titles != null ? [titles] : [];
  if (!Array.isArray(pcts)) pcts = pcts != null ? [pcts] : [];
  let slugs = body.otherSectionSlug;
  if (!Array.isArray(slugs)) slugs = slugs != null ? [slugs] : [];
  const n = Math.max(titles.length, pcts.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = String(titles[i] != null ? titles[i] : '').trim();
    const p = parseInt(pcts[i], 10);
    if (!t && (Number.isNaN(p) || p === 0)) continue;
    const slugRaw = slugs[i] != null ? String(slugs[i]).trim() : '';
    out.push({
      title: t,
      percent: Number.isNaN(p) ? 0 : Math.min(100, Math.max(0, p)),
      slug: slugRaw,
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
  const r = await query(
    getPool,
    `SELECT id, name, purpose, status, citation_style, template_key, created_at, updated_at, started_at, completed_at
     FROM projects WHERE user_id = @user_id ORDER BY updated_at DESC`,
    { user_id: userId }
  );
  return r.recordset;
}

async function getProjectBundle(getPool, projectId, userId) {
  const proj = await query(
    getPool,
    `SELECT * FROM projects WHERE id = @id AND user_id = @user_id`,
    { id: projectId, user_id: userId }
  );
  if (!proj.recordset[0]) return null;
  const secs = await query(
    getPool,
    `SELECT id, project_id, sort_order, title, slug, status, progress_percent, body, draft_revision, created_at, updated_at
     FROM project_sections WHERE project_id = @project_id ORDER BY sort_order`,
    { project_id: projectId }
  );
  const cnt = await query(
    getPool,
    `SELECT COUNT(*) AS n FROM sources WHERE project_id = @project_id`,
    { project_id: projectId }
  );
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
  if (tpl[templateKey].deprecated) {
    return { ok: false, status: 400, error: 'This template is no longer available for new projects.' };
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
      slug: (s.slug && String(s.slug).trim()) || slugFromTitle(s.title, i),
      progress_percent: s.percent,
    }));
  } else {
    const rawSections = tpl[templateKey].sections || [];
    const pcts = normalizeTemplateSectionPercents(rawSections);
    sectionsToInsert = rawSections.map((s, i) => ({
      title: s.title,
      slug: s.slug || slugFromTitle(s.title, i),
      progress_percent: pcts[i],
    }));
  }

  let newProjectId;
  await withTransaction(getPool, async (q) => {
    const ins = await q(
      `
        INSERT INTO projects (user_id, name, purpose, purpose_other, citation_style, template_key, status, started_at, updated_at)
        VALUES (@user_id, @name, @purpose, @purpose_other, @citation_style, @template_key, @status, NOW(), NOW())
      `,
      {
        user_id: userId,
        name: String(name).trim(),
        purpose,
        purpose_other: purpose === 'Other' ? purposeOther : null,
        citation_style: citationStyle,
        template_key: templateKey,
        status: 'active',
      }
    );
    newProjectId = ins.insertId;
    if (!newProjectId) throw new Error('INSERT projects did not return insertId');
    for (let i = 0; i < sectionsToInsert.length; i++) {
      const s = sectionsToInsert[i];
      const prog = s.progress_percent != null ? s.progress_percent : 0;
      await q(
        `
          INSERT INTO project_sections (project_id, sort_order, title, slug, progress_percent, updated_at)
          VALUES (@project_id, @sort_order, @title, @slug, @progress_percent, NOW())
        `,
        {
          project_id: newProjectId,
          sort_order: i,
          title: s.title,
          slug: s.slug || null,
          progress_percent: prog,
        }
      );
    }
  });

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

  const proj = bundle.project;

  const updates = [];
  const params = { id: projectId, user_id: userId };

  if (name !== undefined) {
    updates.push('name = @name');
    params.name = name;
  }
  if (purpose !== undefined) {
    updates.push('purpose = @purpose');
    params.purpose = purpose;
    if (purpose === 'Other' && purposeOther !== undefined) {
      updates.push('purpose_other = @purpose_other');
      params.purpose_other = purposeOther;
    } else if (purpose !== 'Other') {
      updates.push('purpose_other = NULL');
    }
  } else if (purposeOther !== undefined && proj.purpose === 'Other') {
    updates.push('purpose_other = @purpose_other');
    params.purpose_other = purposeOther;
  }
  if (citationStyle !== undefined) {
    updates.push('citation_style = @citation_style');
    params.citation_style = citationStyle;
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

    await withTransaction(getPool, async (q) => {
      const txParams = { id: projectId, user_id: userId };
      let projSql = 'UPDATE projects SET updated_at = NOW()';
      if (name !== undefined) {
        projSql += ', name = @name';
        txParams.name = name;
      }
      if (purpose !== undefined) {
        projSql += ', purpose = @purpose';
        txParams.purpose = purpose;
        if (purpose === 'Other' && purposeOther !== undefined) {
          projSql += ', purpose_other = @purpose_other';
          txParams.purpose_other = purposeOther;
        } else if (purpose !== 'Other') {
          projSql += ', purpose_other = NULL';
        }
      } else if (purposeOther !== undefined && proj.purpose === 'Other') {
        projSql += ', purpose_other = @purpose_other';
        txParams.purpose_other = purposeOther;
      }
      if (citationStyle !== undefined) {
        projSql += ', citation_style = @citation_style';
        txParams.citation_style = citationStyle;
      }
      projSql += ' WHERE id = @id AND user_id = @user_id';
      await q(projSql, txParams);

      for (const row of parsed) {
        await q(
          `UPDATE project_sections SET title = @title, progress_percent = @progress_percent, updated_at = NOW() WHERE id = @sid`,
          { sid: row.id, title: row.title, progress_percent: row.percent }
        );
      }
    });
    const out = await getProjectBundle(getPool, projectId, userId);
    return { ok: true, bundle: out };
  }

  if (updates.length === 0) {
    return { ok: false, status: 400, error: 'No valid fields to update' };
  }
  updates.push('updated_at = NOW()');
  const sqlText = `UPDATE projects SET ${updates.join(', ')} WHERE id = @id AND user_id = @user_id`;
  const r = await query(getPool, sqlText, params);
  if (r.rowsAffected[0] === 0) return { ok: false, status: 404, error: 'Not found' };
  const out = await getProjectBundle(getPool, projectId, userId);
  return { ok: true, bundle: out };
}

/**
 * Permanently delete a project and related rows. `anvil_suggestions` uses ON DELETE NO ACTION to `projects`, so it is removed first.
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
async function deleteProject(getPool, userId, projectId) {
  try {
    await withTransaction(getPool, async (q) => {
      const proj = await q('SELECT id FROM projects WHERE id = @id AND user_id = @user_id', {
        id: projectId,
        user_id: userId,
      });
      if (!proj.recordset[0]) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      await q('DELETE FROM anvil_suggestions WHERE project_id = @project_id', { project_id: projectId });
      const del = await q('DELETE FROM projects WHERE id = @id AND user_id = @user_id', {
        id: projectId,
        user_id: userId,
      });
      if (del.rowsAffected[0] === 0) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
    });
    return { ok: true };
  } catch (e) {
    if (e.code === 'NOT_FOUND') return { ok: false, status: 404, error: 'Not found' };
    throw e;
  }
}

module.exports = {
  PURPOSES,
  CITATION_STYLES,
  loadTemplates,
  saveProjectTemplates,
  attachTemplateMeta,
  templateOptionsForForm,
  listProjects,
  getProjectBundle,
  createProject,
  updateProjectSettings,
  deleteProject,
};
