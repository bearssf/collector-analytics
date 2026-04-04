'use strict';

const { query } = require('./db');
const { loadTemplates } = require('./projectService');

/** @param {object} proj */
function dashboardCategory(proj) {
  const st = String(proj.status || '').toLowerCase();
  if (st === 'canceled') return 'canceled';
  if (st === 'completed' || proj.completed_at) return 'completed';
  return 'active';
}

/**
 * @param {function} getPool
 * @param {object[]} projects — rows from listProjects
 * @returns {Promise<object[]>} projectProgress entries for dashboard + client
 */
async function buildDashboardProjectProgress(getPool, projects) {
  const tpl = loadTemplates();
  const projectProgress = [];
  if (!projects || !projects.length) return projectProgress;

  const pids = projects.map((p) => p.id);
  const params = {};
  const inList = pids
    .map((id, i) => {
      const k = 'rp' + i;
      params[k] = id;
      return '@' + k;
    })
    .join(', ');
  const r = await query(
    getPool,
    `SELECT project_id, section_id, COUNT(*) AS n
     FROM research_plan_items
     WHERE project_id IN (${inList})
       AND COALESCE(status, 'unresolved') = 'unresolved'
     GROUP BY project_id, section_id`,
    params
  );
  const researchMap = new Map();
  for (const row of r.recordset || []) {
    const pid = row.project_id;
    const sid = row.section_id;
    researchMap.set(`${pid}:${sid}`, Number(row.n) || 0);
  }

  for (const proj of projects) {
    const secs = await query(
      getPool,
      'SELECT id, title, slug, body, sort_order FROM project_sections WHERE project_id = @pid ORDER BY sort_order',
      { pid: proj.id }
    );
    const def = proj.template_key && tpl[proj.template_key] ? tpl[proj.template_key] : null;
    const docTarget = def && def.projectedTotalWords ? Math.max(1, Math.round(Number(def.projectedTotalWords))) : 0;
    const tplSections = def && def.sections ? def.sections : [];

    let totalWords = 0;
    let researchOpenTotal = 0;
    const sections = [];
    for (let i = 0; i < secs.recordset.length; i++) {
      const row = secs.recordset[i];
      let words = 0;
      if (row.body) {
        const text = String(row.body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text) words = text.split(/\s+/).length;
      }
      totalWords += words;
      const tplSec = tplSections[i] || {};
      const secPct = tplSec.percent || 0;
      const manualW =
        tplSec.projectedWords != null && tplSec.projectedWords !== ''
          ? Math.round(Number(tplSec.projectedWords))
          : null;
      const secTarget =
        manualW != null && Number.isFinite(manualW) && manualW >= 0
          ? manualW
          : docTarget > 0 && secPct > 0
            ? Math.round((docTarget * secPct) / 100)
            : 0;
      const secCompletePct = secTarget > 0 ? Math.min(100, Math.round((words / secTarget) * 100)) : 0;
      const researchOpen = researchMap.get(`${proj.id}:${row.id}`) || 0;
      researchOpenTotal += researchOpen;
      sections.push({
        id: row.id,
        slug: row.slug != null ? String(row.slug).trim() : '',
        title: row.title,
        words,
        target: secTarget,
        pct: secCompletePct,
        researchOpen,
      });
    }
    const pct = docTarget > 0 ? Math.min(100, Math.round((totalWords / docTarget) * 100)) : 0;
    projectProgress.push({
      id: proj.id,
      name: proj.name,
      totalWords,
      target: docTarget,
      pct,
      researchOpenTotal,
      sections,
    });
  }

  return projectProgress;
}

module.exports = {
  buildDashboardProjectProgress,
  dashboardCategory,
};
