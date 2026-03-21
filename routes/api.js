const express = require('express');
const sql = require('mssql');
const { ensureSubscriptionRow, getSubscriptionRow, appAccessFromRow } = require('../lib/subscriptions');
const {
  PURPOSES,
  CITATION_STYLES,
  loadTemplates,
  listProjects,
  getProjectBundle,
  createProject,
} = require('../lib/projectService');

function requireApiAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function createApiRouter(getPool) {
  const router = express.Router();
  router.use(requireApiAuth);

  router.get('/me', async (req, res, next) => {
    try {
      await ensureSubscriptionRow(getPool, req.session.userId);
      const sub = await getSubscriptionRow(getPool, req.session.userId);
      res.json({
        user: {
          id: req.session.user.id,
          email: req.session.user.email,
          firstName: req.session.user.firstName,
          lastName: req.session.user.lastName,
        },
        subscription: sub,
        appAccess: appAccessFromRow(sub),
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/templates', (req, res) => {
    const tpl = loadTemplates();
    const templates = Object.keys(tpl).map((k) => ({ key: k, label: tpl[k].label }));
    res.json({ templates });
  });

  router.get('/projects', async (req, res, next) => {
    try {
      const projects = await listProjects(getPool, req.session.userId);
      res.json({ projects });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects', async (req, res, next) => {
    try {
      const result = await createProject(getPool, req.session.userId, req.body);
      if (!result.ok) {
        const { status, error, allowed } = result;
        const payload = { error };
        if (allowed) payload.allowed = allowed;
        return res.status(status).json(payload);
      }
      res.status(201).json(result.bundle);
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      res.json(bundle);
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const body = req.body || {};
      const updates = [];
      const p = await getPool();
      const reqB = p.request().input('id', sql.Int, projectId).input('user_id', sql.Int, req.session.userId);
      if (body.name !== undefined) {
        updates.push('name = @name');
        reqB.input('name', sql.NVarChar(255), String(body.name).trim());
      }
      if (body.status !== undefined) {
        updates.push('status = @status');
        reqB.input('status', sql.NVarChar(40), body.status);
      }
      ['publishing_title', 'publishing_venue', 'publishing_disposition'].forEach((k) => {
        if (body[k] !== undefined) {
          updates.push(`${k} = @${k}`);
          reqB.input(k, sql.NVarChar(500), body[k]);
        }
      });
      if (body.publishing_submitted_at !== undefined) {
        updates.push('publishing_submitted_at = @publishing_submitted_at');
        reqB.input('publishing_submitted_at', sql.DateTime2, body.publishing_submitted_at ? new Date(body.publishing_submitted_at) : null);
      }
      if (body.publishing_published_at !== undefined) {
        updates.push('publishing_published_at = @publishing_published_at');
        reqB.input('publishing_published_at', sql.DateTime2, body.publishing_published_at ? new Date(body.publishing_published_at) : null);
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
      updates.push('updated_at = GETDATE()');
      const sqlText = `UPDATE projects SET ${updates.join(', ')} WHERE id = @id AND user_id = @user_id`;
      const r = await reqB.query(sqlText);
      if (r.rowsAffected[0] === 0) return res.status(404).json({ error: 'Not found' });
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      res.json(bundle);
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId/sections/:sectionId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId)) return res.status(400).json({ error: 'invalid id' });
      const body = req.body || {};
      const p = await getPool();
      const own = await p
        .request()
        .input('sid', sql.Int, sectionId)
        .input('pid', sql.Int, projectId)
        .input('user_id', sql.Int, req.session.userId)
        .query(
          `SELECT ps.id FROM project_sections ps
           INNER JOIN projects pr ON pr.id = ps.project_id
           WHERE ps.id = @sid AND ps.project_id = @pid AND pr.user_id = @user_id`
        );
      if (!own.recordset[0]) return res.status(404).json({ error: 'Not found' });

      const updates = [];
      const reqB = p.request().input('sid', sql.Int, sectionId);
      if (body.status !== undefined) {
        updates.push('status = @status');
        reqB.input('status', sql.NVarChar(40), body.status);
      }
      if (body.progressPercent !== undefined) {
        updates.push('progress_percent = @progress_percent');
        const pp = parseInt(body.progressPercent, 10);
        reqB.input('progress_percent', sql.TinyInt, Math.min(100, Math.max(0, Number.isNaN(pp) ? 0 : pp)));
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
      updates.push('updated_at = GETDATE()');
      await reqB.query(`UPDATE project_sections SET ${updates.join(', ')} WHERE id = @sid`);
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      res.json(bundle);
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId/sources', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const p = await getPool();
      const own = await p
        .request()
        .input('id', sql.Int, projectId)
        .input('user_id', sql.Int, req.session.userId)
        .query('SELECT id FROM projects WHERE id = @id AND user_id = @user_id');
      if (!own.recordset[0]) return res.status(404).json({ error: 'Not found' });

      const rows = await p
        .request()
        .input('project_id', sql.Int, projectId)
        .query(
          `SELECT s.id, s.project_id, s.citation_text, s.notes, s.sort_order, s.created_at, s.updated_at
           FROM sources s WHERE s.project_id = @project_id ORDER BY s.sort_order, s.id`
        );
      const sources = rows.recordset;
      for (const s of sources) {
        const sec = await p
          .request()
          .input('source_id', sql.Int, s.id)
          .query(`SELECT section_id FROM source_sections WHERE source_id = @source_id`);
        s.sectionIds = sec.recordset.map((r) => r.section_id);
      }
      res.json({ sources });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/sources', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const { citationText, notes, sectionIds } = req.body || {};
      if (!citationText || !String(citationText).trim()) return res.status(400).json({ error: 'citationText is required' });
      const p = await getPool();
      const own = await p
        .request()
        .input('id', sql.Int, projectId)
        .input('user_id', sql.Int, req.session.userId)
        .query('SELECT id FROM projects WHERE id = @id AND user_id = @user_id');
      if (!own.recordset[0]) return res.status(404).json({ error: 'Not found' });

      const ins = await p
        .request()
        .input('project_id', sql.Int, projectId)
        .input('citation_text', sql.NVarChar(sql.MAX), String(citationText).trim())
        .input('notes', sql.NVarChar(sql.MAX), notes != null ? String(notes) : null)
        .query(`
          INSERT INTO sources (project_id, citation_text, notes, updated_at)
          OUTPUT INSERTED.id
          VALUES (@project_id, @citation_text, @notes, GETDATE())
        `);
      const sourceId = ins.recordset[0].id;

      const ids = Array.isArray(sectionIds) ? sectionIds.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x)) : [];
      for (const secId of ids) {
        const ok = await p
          .request()
          .input('section_id', sql.Int, secId)
          .input('project_id', sql.Int, projectId)
          .query('SELECT id FROM project_sections WHERE id = @section_id AND project_id = @project_id');
        if (ok.recordset[0]) {
          await p
            .request()
            .input('source_id', sql.Int, sourceId)
            .input('section_id', sql.Int, secId)
            .query(
              `IF NOT EXISTS (SELECT 1 FROM source_sections WHERE source_id = @source_id AND section_id = @section_id)
               INSERT INTO source_sections (source_id, section_id) VALUES (@source_id, @section_id)`
            );
        }
      }

      const row = await p
        .request()
        .input('id', sql.Int, sourceId)
        .query(`SELECT id, project_id, citation_text, notes, sort_order, created_at, updated_at FROM sources WHERE id = @id`);
      const out = row.recordset[0];
      const sec = await p
        .request()
        .input('source_id', sql.Int, sourceId)
        .query(`SELECT section_id FROM source_sections WHERE source_id = @source_id`);
      out.sectionIds = sec.recordset.map((r) => r.section_id);
      res.status(201).json({ source: out });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/sources/:sourceId', async (req, res, next) => {
    try {
      const sourceId = parseInt(req.params.sourceId, 10);
      if (Number.isNaN(sourceId)) return res.status(400).json({ error: 'invalid source id' });
      const body = req.body || {};
      const p = await getPool();
      const own = await p
        .request()
        .input('sid', sql.Int, sourceId)
        .input('user_id', sql.Int, req.session.userId)
        .query(
          `SELECT s.id FROM sources s
           INNER JOIN projects pr ON pr.id = s.project_id
           WHERE s.id = @sid AND pr.user_id = @user_id`
        );
      if (!own.recordset[0]) return res.status(404).json({ error: 'Not found' });

      const reqB = p.request().input('sid', sql.Int, sourceId);
      const updates = [];
      if (body.citationText !== undefined) {
        updates.push('citation_text = @citation_text');
        reqB.input('citation_text', sql.NVarChar(sql.MAX), String(body.citationText).trim());
      }
      if (body.notes !== undefined) {
        updates.push('notes = @notes');
        reqB.input('notes', sql.NVarChar(sql.MAX), body.notes != null ? String(body.notes) : null);
      }
      if (body.sortOrder !== undefined) {
        updates.push('sort_order = @sort_order');
        reqB.input('sort_order', sql.Int, parseInt(body.sortOrder, 10));
      }
      if (updates.length === 0 && !Array.isArray(body.sectionIds)) return res.status(400).json({ error: 'No valid fields' });
      if (updates.length) {
        updates.push('updated_at = GETDATE()');
        await reqB.query(`UPDATE sources SET ${updates.join(', ')} WHERE id = @sid`);
      }

      if (Array.isArray(body.sectionIds)) {
        await p.request().input('source_id', sql.Int, sourceId).query(`DELETE FROM source_sections WHERE source_id = @source_id`);
        const proj = await p
          .request()
          .input('sid', sql.Int, sourceId)
          .query(`SELECT project_id FROM sources WHERE id = @sid`);
        const projectId = proj.recordset[0].project_id;
        for (const secId of body.sectionIds.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x))) {
          const ok = await p
            .request()
            .input('section_id', sql.Int, secId)
            .input('project_id', sql.Int, projectId)
            .query('SELECT id FROM project_sections WHERE id = @section_id AND project_id = @project_id');
          if (ok.recordset[0]) {
            await p
              .request()
              .input('source_id', sql.Int, sourceId)
              .input('section_id', sql.Int, secId)
              .query(`INSERT INTO source_sections (source_id, section_id) VALUES (@source_id, @section_id)`);
          }
        }
      }

      const row = await p
        .request()
        .input('id', sql.Int, sourceId)
        .query(`SELECT id, project_id, citation_text, notes, sort_order, created_at, updated_at FROM sources WHERE id = @id`);
      const out = row.recordset[0];
      const sec = await p
        .request()
        .input('source_id', sql.Int, sourceId)
        .query(`SELECT section_id FROM source_sections WHERE source_id = @source_id`);
      out.sectionIds = sec.recordset.map((r) => r.section_id);
      res.json({ source: out });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/sources/:sourceId', async (req, res, next) => {
    try {
      const sourceId = parseInt(req.params.sourceId, 10);
      if (Number.isNaN(sourceId)) return res.status(400).json({ error: 'invalid source id' });
      const p = await getPool();
      const r = await p
        .request()
        .input('sid', sql.Int, sourceId)
        .input('user_id', sql.Int, req.session.userId)
        .query(
          `DELETE s FROM sources s
           INNER JOIN projects pr ON pr.id = s.project_id
           WHERE s.id = @sid AND pr.user_id = @user_id`
        );
      if (!r.rowsAffected || r.rowsAffected[0] === 0) return res.status(404).json({ error: 'Not found' });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = createApiRouter;
