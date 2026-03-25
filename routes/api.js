const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const { ensureSubscriptionRow, getSubscriptionRow, appAccessFromRow } = require('../lib/subscriptions');
const { ALLOWED_TITLES, SEARCH_ENGINES } = require('../lib/userConstants');
const { getUserProfileRow, rowToPublicUser } = require('../lib/userProfile');
const {
  loadTemplates,
  listProjects,
  getProjectBundle,
  createProject,
  updateProjectSettings,
  deleteProject,
  attachTemplateMeta,
} = require('../lib/projectService');
const {
  buildSectionDocxBuffer,
  buildProjectDocxBuffer,
  buildPlainTextForProject,
  sanitizeFilename,
  contentDispositionAttachment,
} = require('../lib/documentExport');
const {
  normalizeCategory,
  isValidStatus,
  rowToSuggestion,
} = require('../lib/anvilFeedback');
const { insertAnvilSuggestions } = require('../lib/anvilSuggestionStore');
const { staleFeedbackEnabled } = require('../lib/anvilStaleFeedback');
const { isBedrockConfigured } = require('../lib/bedrockReview');
const { runStructuredSectionReview } = require('../lib/bedrockStructuredReview');
const { applySuggestionToDraftHtml } = require('../lib/bedrockApplySuggestion');
const { searchPapers } = require('../lib/semanticScholar');

function mapSuggestionRow(r) {
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
    section_draft_revision: r.section_draft_revision,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

function requireApiAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function createApiRouter(getPool) {
  const router = express.Router();
  router.use(requireApiAuth);

  const anvilUploadDir = path.join(__dirname, '..', 'public', 'uploads', 'anvil');
  const anvilUpload = multer({
    storage: multer.diskStorage({
      destination: function (req, file, cb) {
        try {
          fs.mkdirSync(anvilUploadDir, { recursive: true });
        } catch (e) {
          /* ignore */
        }
        cb(null, anvilUploadDir);
      },
      filename: function (req, file, cb) {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const safeExt = allowed.includes(ext) ? ext : '.png';
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 12) + safeExt);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed.'));
      }
      cb(null, true);
    },
  });

  router.post(
    '/projects/:projectId/anvil/upload',
    function (req, res, next) {
      anvilUpload.single('image')(req, res, function (err) {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large (max 5 MB).' });
          }
          return res.status(400).json({ error: err.message || 'Upload failed.' });
        }
        next();
      });
    },
    async function (req, res, next) {
      try {
        const projectId = parseInt(req.params.projectId, 10);
        if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
        const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
        if (!bundle) return res.status(404).json({ error: 'Not found' });
        if (!req.file) return res.status(400).json({ error: 'No image file.' });
        res.json({ url: '/uploads/anvil/' + req.file.filename });
      } catch (e) {
        next(e);
      }
    }
  );

  router.get('/me', async (req, res, next) => {
    try {
      await ensureSubscriptionRow(getPool, req.session.userId);
      const sub = await getSubscriptionRow(getPool, req.session.userId);
      const row = await getUserProfileRow(getPool, req.session.userId);
      const user = row ? rowToPublicUser(row) : {
        id: req.session.user.id,
        email: req.session.user.email,
        firstName: req.session.user.firstName,
        lastName: req.session.user.lastName,
        title: null,
        university: null,
        researchFocus: null,
        preferredSearchEngine: null,
      };
      res.json({
        user,
        subscription: sub,
        appAccess: appAccessFromRow(sub),
      });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/me', async (req, res, next) => {
    try {
      const body = req.body || {};
      const title = (body.title || '').trim();
      const firstName = (body.firstName || '').trim();
      const lastName = (body.lastName || '').trim();
      const university = (body.university || '').trim();
      const researchFocus = (body.researchFocus || '').trim();
      const preferredSearchEngine = (body.preferredSearchEngine || '').trim();

      if (!ALLOWED_TITLES.includes(title)) {
        return res.status(400).json({ error: 'Invalid title.' });
      }
      if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First and last name are required.' });
      }
      if (preferredSearchEngine && !SEARCH_ENGINES.includes(preferredSearchEngine)) {
        return res.status(400).json({ error: 'Invalid preferred search engine.' });
      }

      const p = await getPool();
      await p
        .request()
        .input('id', sql.Int, req.session.userId)
        .input('title', sql.NVarChar(20), title)
        .input('first_name', sql.NVarChar(100), firstName)
        .input('last_name', sql.NVarChar(100), lastName)
        .input('university', sql.NVarChar(255), university || null)
        .input('research_focus', sql.NVarChar(sql.MAX), researchFocus || null)
        .input('preferred_search_engine', sql.NVarChar(100), preferredSearchEngine || null)
        .query(
          `UPDATE users SET
            title = @title,
            first_name = @first_name,
            last_name = @last_name,
            university = @university,
            research_focus = @research_focus,
            preferred_search_engine = @preferred_search_engine
           WHERE id = @id`
        );

      req.session.user = {
        id: req.session.userId,
        firstName,
        lastName,
        email: req.session.user.email,
      };

      await ensureSubscriptionRow(getPool, req.session.userId);
      const sub = await getSubscriptionRow(getPool, req.session.userId);
      const row = await getUserProfileRow(getPool, req.session.userId);
      res.json({
        user: rowToPublicUser(row),
        subscription: sub,
        appAccess: appAccessFromRow(sub),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/me/password', async (req, res, next) => {
    try {
      const body = req.body || {};
      const currentPassword = body.currentPassword || '';
      const newPassword = body.newPassword || '';
      const confirmPassword = body.confirmPassword || '';

      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required.' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New password and confirmation do not match.' });
      }

      const p = await getPool();
      const r = await p
        .request()
        .input('id', sql.Int, req.session.userId)
        .query('SELECT password_hash FROM users WHERE id = @id');
      const row = r.recordset[0];
      if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await p
        .request()
        .input('id', sql.Int, req.session.userId)
        .input('password_hash', sql.NVarChar(255), hash)
        .query('UPDATE users SET password_hash = @password_hash WHERE id = @id');

      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.get('/templates', (req, res) => {
    const tpl = loadTemplates();
    const templates = Object.keys(tpl)
      .filter((k) => !tpl[k].deprecated)
      .map((k) => ({ key: k, label: tpl[k].label }));
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
      attachTemplateMeta(result.bundle);
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
      attachTemplateMeta(bundle);
      res.json(bundle);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/projects/:projectId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const result = await deleteProject(getPool, req.session.userId, projectId);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const body = req.body || {};

      const hasMeta =
        body.name !== undefined ||
        body.purpose !== undefined ||
        body.citationStyle !== undefined ||
        body.purposeOther !== undefined ||
        body.otherSections !== undefined ||
        body.otherSectionsJson !== undefined;

      if (hasMeta) {
        const result = await updateProjectSettings(getPool, req.session.userId, projectId, body);
        if (!result.ok) {
          const payload = { error: result.error };
          if (result.allowed) payload.allowed = result.allowed;
          return res.status(result.status).json(payload);
        }
      }

      const updates = [];
      const p = await getPool();
      const reqB = p.request().input('id', sql.Int, projectId).input('user_id', sql.Int, req.session.userId);
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
      if (updates.length > 0) {
        updates.push('updated_at = GETDATE()');
        const sqlText = `UPDATE projects SET ${updates.join(', ')} WHERE id = @id AND user_id = @user_id`;
        const r = await reqB.query(sqlText);
        if (r.rowsAffected[0] === 0) return res.status(404).json({ error: 'Not found' });
      } else if (!hasMeta) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      attachTemplateMeta(bundle);
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
      if (body.title !== undefined) {
        updates.push('title = @title');
        reqB.input('title', sql.NVarChar(255), String(body.title).trim());
      }
      let bodyChanged = false;
      if (body.body !== undefined) {
        updates.push('body = @body');
        reqB.input('body', sql.NVarChar(sql.MAX), body.body != null ? String(body.body) : null);
        if (staleFeedbackEnabled()) {
          updates.push('draft_revision = draft_revision + 1');
        }
        bodyChanged = true;
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
      updates.push('updated_at = GETDATE()');
      await reqB.query(`UPDATE project_sections SET ${updates.join(', ')} WHERE id = @sid`);
      let invalidatedOpen = 0;
      if (staleFeedbackEnabled() && bodyChanged) {
        const revRow = await p
          .request()
          .input('sid', sql.Int, sectionId)
          .input('pid', sql.Int, projectId)
          .query(
            `SELECT draft_revision FROM project_sections WHERE id = @sid AND project_id = @pid`
          );
        const newRev =
          revRow.recordset[0] && revRow.recordset[0].draft_revision != null
            ? Number(revRow.recordset[0].draft_revision)
            : 0;
        const del = await p
          .request()
          .input('sid', sql.Int, sectionId)
          .input('pid', sql.Int, projectId)
          .input('rev', sql.Int, newRev)
          .query(
            `DELETE FROM anvil_suggestions WHERE section_id = @sid AND project_id = @pid
             AND suggestion_status = N'open' AND COALESCE(draft_revision_at_generation, -1) < @rev`
          );
        invalidatedOpen = del.rowsAffected && del.rowsAffected[0] ? del.rowsAffected[0] : 0;
      }
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      attachTemplateMeta(bundle);
      if (staleFeedbackEnabled() && bodyChanged) {
        res.json({ bundle, anvilFeedbackInvalidated: { count: invalidatedOpen } });
      } else {
        res.json(bundle);
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId/export', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const format = String(req.query.format || '').toLowerCase();
      if (format !== 'txt' && format !== 'docx') {
        return res.status(400).json({ error: 'query format must be txt or docx' });
      }
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      const projectName = bundle.project.name || 'Project';
      const sections = (bundle.sections || []).map(function (s) {
        return {
          title: s.title,
          body: s.body != null ? String(s.body) : '',
        };
      });
      const base = sanitizeFilename(projectName);
      if (format === 'txt') {
        const text = buildPlainTextForProject(projectName, sections);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', contentDispositionAttachment(base + '.txt'));
        res.send(Buffer.from(text, 'utf8'));
        return;
      }
      const citationStyle =
        bundle.project.citation_style != null
          ? String(bundle.project.citation_style)
          : bundle.project.citationStyle != null
            ? String(bundle.project.citationStyle)
            : 'APA';
      const buf = await buildProjectDocxBuffer({ projectName, sections, citationStyle });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', contentDispositionAttachment(base + '.docx'));
      res.send(Buffer.from(buf));
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/export-project-docx', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      const body = req.body || {};
      const sectionsIn = Array.isArray(body.sections) ? body.sections : [];
      if (!sectionsIn.length) {
        return res.status(400).json({ error: 'sections array required' });
      }
      const citationStyle =
        body.citationStyle != null
          ? String(body.citationStyle)
          : bundle.project.citation_style != null
            ? String(bundle.project.citation_style)
            : bundle.project.citationStyle != null
              ? String(bundle.project.citationStyle)
              : 'APA';
      const projectName =
        body.projectName != null ? String(body.projectName).trim() : bundle.project.name || 'Project';
      const sections = sectionsIn.map(function (s) {
        return {
          title: s.title != null ? String(s.title) : 'Section',
          body: s.body != null ? String(s.body) : '',
        };
      });
      const buf = await buildProjectDocxBuffer({ projectName, sections, citationStyle });
      const base = sanitizeFilename(projectName);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', contentDispositionAttachment(base + '.docx'));
      res.send(Buffer.from(buf));
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/sections/:sectionId/export-docx', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId)) {
        return res.status(400).json({ error: 'invalid id' });
      }
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      const sec = bundle.sections.find(function (s) {
        return Number(s.id) === sectionId;
      });
      if (!sec) return res.status(404).json({ error: 'Section not found' });
      const body = req.body || {};
      const html = body.html != null ? String(body.html) : '';
      const title =
        (body.title != null ? String(body.title).trim() : '') || String(sec.title || 'Section');
      const citationStyle =
        body.citationStyle != null
          ? String(body.citationStyle)
          : bundle.project.citation_style != null
            ? String(bundle.project.citation_style)
            : bundle.project.citationStyle != null
              ? String(bundle.project.citationStyle)
              : 'APA';
      const buf = await buildSectionDocxBuffer({ title, html, citationStyle });
      const fname = sanitizeFilename(title) + '.docx';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', contentDispositionAttachment(fname));
      res.send(Buffer.from(buf));
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId/sections/:sectionId/suggestions', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId)) {
        return res.status(400).json({ error: 'invalid id' });
      }
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

      const rows = await p
        .request()
        .input('section_id', sql.Int, sectionId)
        .input('project_id', sql.Int, projectId)
        .query(
          `SELECT s.id, s.project_id, s.section_id, s.category, s.body, s.suggestion_status, s.anchor_json,
                  s.draft_revision_at_generation, ps.draft_revision AS section_draft_revision,
                  s.created_at, s.updated_at
           FROM anvil_suggestions s
           INNER JOIN project_sections ps ON ps.id = s.section_id AND ps.project_id = s.project_id
           WHERE s.section_id = @section_id AND s.project_id = @project_id
           ORDER BY s.created_at DESC`
        );
      const suggestions = rows.recordset.map(mapSuggestionRow).filter(Boolean);
      res.json({ suggestions });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/sections/:sectionId/suggestions', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId)) {
        return res.status(400).json({ error: 'invalid id' });
      }
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

      const body = req.body || {};
      const items = [];
      if (Array.isArray(body.suggestions)) {
        for (const raw of body.suggestions) {
          const cat = normalizeCategory(raw && raw.category);
          const text = raw && raw.body != null ? String(raw.body).trim() : '';
          if (!cat || !text) {
            return res.status(400).json({ error: 'Each suggestion needs category and non-empty body' });
          }
          items.push({
            category: cat,
            body: text,
            anchorJson: raw.anchorJson != null ? String(raw.anchorJson).slice(0, 500) : null,
          });
        }
      } else {
        const cat = normalizeCategory(body.category);
        const text = body.body != null ? String(body.body).trim() : '';
        if (!cat || !text) return res.status(400).json({ error: 'category and body are required' });
        items.push({
          category: cat,
          body: text,
          anchorJson: body.anchorJson != null ? String(body.anchorJson).slice(0, 500) : null,
        });
      }

      if (items.length === 0) return res.status(400).json({ error: 'No suggestions to save' });

      const created = await insertAnvilSuggestions(getPool, projectId, sectionId, items);

      res.status(201).json({ suggestions: created });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId/suggestions/:suggestionId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const suggestionId = parseInt(req.params.suggestionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(suggestionId)) {
        return res.status(400).json({ error: 'invalid id' });
      }
      const body = req.body || {};
      const newStatus = body.status != null ? String(body.status).toLowerCase() : '';
      if (!isValidStatus(newStatus) || newStatus === 'open') {
        return res.status(400).json({ error: 'status must be applied or ignored' });
      }

      const p = await getPool();
      const upd = await p
        .request()
        .input('sid', sql.Int, suggestionId)
        .input('pid', sql.Int, projectId)
        .input('user_id', sql.Int, req.session.userId)
        .input('suggestion_status', sql.NVarChar(20), newStatus)
        .query(
          `UPDATE sug
           SET suggestion_status = @suggestion_status, updated_at = GETDATE()
           FROM anvil_suggestions AS sug
           INNER JOIN projects AS pr ON pr.id = sug.project_id AND pr.user_id = @user_id
           WHERE sug.id = @sid AND sug.project_id = @pid`
        );
      if (!upd.rowsAffected || !upd.rowsAffected[0]) return res.status(404).json({ error: 'Not found' });

      const row = await p
        .request()
        .input('id', sql.Int, suggestionId)
        .query(
          `SELECT id, project_id, section_id, category, body, suggestion_status, anchor_json, draft_revision_at_generation, created_at, updated_at
           FROM anvil_suggestions WHERE id = @id`
        );
      res.json({ suggestion: mapSuggestionRow(row.recordset[0]) });
    } catch (e) {
      next(e);
    }
  });

  router.post(
    '/projects/:projectId/sections/:sectionId/suggestions/:suggestionId/apply-draft',
    async (req, res, next) => {
      try {
        if (!isBedrockConfigured()) {
          return res.status(503).json({
            error: 'Bedrock is not configured',
            bedrockConfigured: false,
          });
        }

        const projectId = parseInt(req.params.projectId, 10);
        const sectionId = parseInt(req.params.sectionId, 10);
        const suggestionId = parseInt(req.params.suggestionId, 10);
        if (Number.isNaN(projectId) || Number.isNaN(sectionId) || Number.isNaN(suggestionId)) {
          return res.status(400).json({ error: 'invalid id' });
        }

        const body = req.body || {};
        const html = body.html != null ? String(body.html) : '';
        if (!html.trim()) {
          return res.status(400).json({ error: 'html is required' });
        }

        const p = await getPool();
        const rowRes = await p
          .request()
          .input('sid', sql.Int, suggestionId)
          .input('sec', sql.Int, sectionId)
          .input('pid', sql.Int, projectId)
          .input('user_id', sql.Int, req.session.userId)
          .query(
            `SELECT sug.id, sug.body, sug.suggestion_status, ps.title AS section_title
             FROM anvil_suggestions AS sug
             INNER JOIN projects AS pr ON pr.id = sug.project_id AND pr.user_id = @user_id
             INNER JOIN project_sections AS ps ON ps.id = sug.section_id AND ps.project_id = sug.project_id
             WHERE sug.id = @sid AND sug.section_id = @sec AND sug.project_id = @pid`
          );

        const row = rowRes.recordset[0];
        if (!row) return res.status(404).json({ error: 'Not found' });

        const st = row.suggestion_status != null ? String(row.suggestion_status).toLowerCase() : 'open';
        if (st !== 'open') {
          return res.status(400).json({ error: 'Suggestion is not open' });
        }

        const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
        const citationStyle =
          bundle && bundle.project
            ? bundle.project.citation_style != null
              ? bundle.project.citation_style
              : bundle.project.citationStyle != null
                ? bundle.project.citationStyle
                : 'APA'
            : 'APA';

        const suggestionText = row.body != null ? String(row.body).trim() : '';
        if (!suggestionText) {
          return res.status(400).json({ error: 'Suggestion has no text' });
        }

        let result;
        try {
          result = await applySuggestionToDraftHtml({
            html,
            suggestionText,
            sectionTitle: row.section_title,
            citationStyle,
          });
        } catch (err) {
          let msg = err && err.message ? String(err.message) : 'Bedrock request failed';
          if (err && err.name === 'AccessDeniedException') {
            msg = 'Bedrock access denied — check IAM permissions and model access in this region.';
          } else if (/inference profile/i.test(msg) && /on-demand|throughput/i.test(msg)) {
            msg +=
              ' Set BEDROCK_INFERENCE_PROFILE_ARN (recommended) or put the inference profile id/ARN in BEDROCK_MODEL_ID — see docs/aws-bedrock.md.';
          }
          return res.status(502).json({ error: msg, bedrockConfigured: true });
        }

        res.json({ html: result.html, bedrockConfigured: true });
      } catch (e) {
        next(e);
      }
    }
  );

  /** The Anvil: structured anchor-based feedback — does not persist to anvil_suggestions. */
  router.post('/projects/:projectId/sections/:sectionId/review-structured', async (req, res, next) => {
    try {
      if (!isBedrockConfigured()) {
        return res.status(503).json({
          error: 'Bedrock is not configured',
          bedrockConfigured: false,
        });
      }

      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId)) {
        return res.status(400).json({ error: 'invalid id' });
      }

      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      const sec = bundle.sections.find(function (s) {
        return Number(s.id) === sectionId;
      });
      if (!sec) return res.status(404).json({ error: 'Section not found' });

      const body = req.body || {};
      let html = body.html != null ? String(body.html) : null;
      if (html == null) {
        html = sec.body != null ? String(sec.body) : '';
      }
      const plainText = body.plainText != null ? String(body.plainText) : null;

      let reviewResult;
      try {
        reviewResult = await runStructuredSectionReview({
          html,
          plainText,
          sectionTitle: sec.title,
        });
      } catch (err) {
        let msg = err && err.message ? String(err.message) : 'Bedrock request failed';
        if (err && err.name === 'AccessDeniedException') {
          msg = 'Bedrock access denied — check IAM permissions and model access in this region.';
        } else if (/inference profile/i.test(msg) && /on-demand|throughput/i.test(msg)) {
          msg +=
            ' Set BEDROCK_INFERENCE_PROFILE_ARN (recommended) or put the inference profile id/ARN in BEDROCK_MODEL_ID — see docs/aws-bedrock.md.';
        }
        return res.status(502).json({ error: msg, bedrockConfigured: true });
      }

      const items = reviewResult.items || [];
      res.json({
        items,
        skipped: Boolean(reviewResult.skipped),
        shortDraft: Boolean(reviewResult.shortDraft),
        bedrockConfigured: true,
      });
    } catch (e) {
      next(e);
    }
  });

  /* ── Semantic Scholar paper search ──────────────────────────────────── */

  router.get('/projects/:projectId/sources/search-scholar', async (req, res, next) => {
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

      const rawQ = req.query.q || req.query.query || '';
      const keywords = rawQ
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
      if (!keywords.length) {
        return res.status(400).json({ error: 'query parameter "q" is required (comma-separated keywords)' });
      }

      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      console.log('[Semantic Scholar] Searching with keywords:', keywords.slice(0, 3), '..., limit:', limit);
      const results = await searchPapers(keywords, {
        limit,
        apiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || undefined,
        year: req.query.year || undefined,
        fieldsOfStudy: req.query.fieldsOfStudy || undefined,
      });
      console.log('[Semantic Scholar] Returned', results.length, 'papers');
      res.json({ papers: results });
    } catch (e) {
      console.error('[Semantic Scholar] Error:', e.message);
      if (e && e.message && e.message.includes('rate limit')) {
        const hasKey = !!process.env.SEMANTIC_SCHOLAR_API_KEY;
        const msg = hasKey
          ? 'Semantic Scholar is temporarily rate-limiting requests. Please try again in a minute.'
          : 'Semantic Scholar requires an API key for reliable access. Add SEMANTIC_SCHOLAR_API_KEY to your environment. Get a free key at semanticscholar.org/product/api';
        return res.status(429).json({ error: msg });
      }
      next(e);
    }
  });

  /* ── Crucible: sources CRUD ─────────────────────────────────────────── */

  async function ownsProject(pool, projectId, userId) {
    const r = await pool
      .request()
      .input('id', sql.Int, projectId)
      .input('user_id', sql.Int, userId)
      .query('SELECT id FROM projects WHERE id = @id AND user_id = @user_id');
    return !!r.recordset[0];
  }

  router.get('/projects/:projectId/sources', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const p = await getPool();
      if (!(await ownsProject(p, projectId, req.session.userId)))
        return res.status(404).json({ error: 'Not found' });

      const rows = await p
        .request()
        .input('pid', sql.Int, projectId)
        .query(
          `SELECT id, project_id, citation_text, notes, crucible_notes, doi,
                  authors, publication_date, article_title, journal_title,
                  volume_number, issue_number, page_numbers, chapter_name, conference_name,
                  source_type, publisher, publisher_location, editors, book_title,
                  url, edition, access_date,
                  sort_order, created_at, updated_at
           FROM sources WHERE project_id = @pid ORDER BY article_title, created_at`
        );

      const tagRows = await p
        .request()
        .input('pid', sql.Int, projectId)
        .query(
          `SELECT st.source_id, st.tag FROM source_tags st
           INNER JOIN sources s ON s.id = st.source_id
           WHERE s.project_id = @pid`
        );
      const tagMap = {};
      tagRows.recordset.forEach(function (r) {
        if (!tagMap[r.source_id]) tagMap[r.source_id] = [];
        tagMap[r.source_id].push(r.tag);
      });

      const secRows = await p
        .request()
        .input('pid', sql.Int, projectId)
        .query(
          `SELECT ss.source_id, ss.section_id FROM source_sections ss
           INNER JOIN sources s ON s.id = ss.source_id
           WHERE s.project_id = @pid`
        );
      const secMap = {};
      secRows.recordset.forEach(function (r) {
        if (!secMap[r.source_id]) secMap[r.source_id] = [];
        secMap[r.source_id].push(r.section_id);
      });

      const sources = rows.recordset.map(function (r) {
        return Object.assign({}, r, {
          tags: tagMap[r.id] || [],
          section_ids: secMap[r.id] || [],
        });
      });
      res.json({ sources });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/sources', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const p = await getPool();
      if (!(await ownsProject(p, projectId, req.session.userId)))
        return res.status(404).json({ error: 'Not found' });

      const b = req.body || {};
      function trimOrNull(v) { return (v || '').trim() || null; }
      const authors          = trimOrNull(b.authors);
      const publicationDate  = trimOrNull(b.publication_date);
      const articleTitle     = trimOrNull(b.article_title);
      const journalTitle     = trimOrNull(b.journal_title);
      const volumeNumber     = trimOrNull(b.volume_number);
      const issueNumber      = trimOrNull(b.issue_number);
      const pageNumbers      = trimOrNull(b.page_numbers);
      const doi              = trimOrNull(b.doi);
      const chapterName      = trimOrNull(b.chapter_name);
      const conferenceName   = trimOrNull(b.conference_name);
      const sourceType       = trimOrNull(b.source_type);
      const publisher        = trimOrNull(b.publisher);
      const publisherLocation = trimOrNull(b.publisher_location);
      const editors          = trimOrNull(b.editors);
      const bookTitle        = trimOrNull(b.book_title);
      const url              = trimOrNull(b.url);
      const edition          = trimOrNull(b.edition);
      const accessDate       = trimOrNull(b.access_date);
      const citationText     = (b.citation_text || '').trim() || '';
      const tags             = Array.isArray(b.tags) ? b.tags.map(function (t) { return String(t).trim(); }).filter(Boolean) : [];
      const sectionIds       = Array.isArray(b.section_ids) ? b.section_ids.map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !Number.isNaN(n); }) : [];

      if (!articleTitle && !citationText) {
        return res.status(400).json({ error: 'Article title or citation text is required.' });
      }

      const ins = await p
        .request()
        .input('pid', sql.Int, projectId)
        .input('citation_text', sql.NVarChar(sql.MAX), citationText)
        .input('doi', sql.NVarChar(500), doi)
        .input('authors', sql.NVarChar(sql.MAX), authors)
        .input('publication_date', sql.NVarChar(100), publicationDate)
        .input('article_title', sql.NVarChar(500), articleTitle)
        .input('journal_title', sql.NVarChar(500), journalTitle)
        .input('volume_number', sql.NVarChar(50), volumeNumber)
        .input('issue_number', sql.NVarChar(50), issueNumber)
        .input('page_numbers', sql.NVarChar(100), pageNumbers)
        .input('chapter_name', sql.NVarChar(500), chapterName)
        .input('conference_name', sql.NVarChar(500), conferenceName)
        .input('source_type', sql.NVarChar(40), sourceType)
        .input('publisher', sql.NVarChar(500), publisher)
        .input('publisher_location', sql.NVarChar(500), publisherLocation)
        .input('editors', sql.NVarChar(sql.MAX), editors)
        .input('book_title', sql.NVarChar(500), bookTitle)
        .input('url', sql.NVarChar(1000), url)
        .input('edition', sql.NVarChar(100), edition)
        .input('access_date', sql.NVarChar(100), accessDate)
        .query(
          `INSERT INTO sources (project_id, citation_text, doi, authors, publication_date, article_title,
            journal_title, volume_number, issue_number, page_numbers, chapter_name, conference_name,
            source_type, publisher, publisher_location, editors, book_title, url, edition, access_date)
           VALUES (@pid, @citation_text, @doi, @authors, @publication_date, @article_title,
            @journal_title, @volume_number, @issue_number, @page_numbers, @chapter_name, @conference_name,
            @source_type, @publisher, @publisher_location, @editors, @book_title, @url, @edition, @access_date);
           SELECT SCOPE_IDENTITY() AS id;`
        );
      const sourceId = ins.recordset[0].id;

      for (const tag of tags) {
        await p
          .request()
          .input('source_id', sql.Int, sourceId)
          .input('tag', sql.NVarChar(120), tag.slice(0, 120))
          .query('INSERT INTO source_tags (source_id, tag) VALUES (@source_id, @tag)');
      }
      for (const secId of sectionIds) {
        await p
          .request()
          .input('source_id', sql.Int, sourceId)
          .input('section_id', sql.Int, secId)
          .query(
            `IF EXISTS (SELECT 1 FROM project_sections WHERE id = @section_id AND project_id = ${projectId})
             INSERT INTO source_sections (source_id, section_id) VALUES (@source_id, @section_id)`
          );
      }

      const row = await p
        .request()
        .input('id', sql.Int, sourceId)
        .query(
          `SELECT id, project_id, citation_text, notes, crucible_notes, doi,
                  authors, publication_date, article_title, journal_title,
                  volume_number, issue_number, page_numbers, chapter_name, conference_name,
                  source_type, publisher, publisher_location, editors, book_title,
                  url, edition, access_date,
                  sort_order, created_at, updated_at
           FROM sources WHERE id = @id`
        );
      const source = row.recordset[0];
      source.tags = tags;
      source.section_ids = sectionIds;
      res.status(201).json({ source });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId/sources/:sourceId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sourceId = parseInt(req.params.sourceId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sourceId))
        return res.status(400).json({ error: 'invalid id' });
      const p = await getPool();
      if (!(await ownsProject(p, projectId, req.session.userId)))
        return res.status(404).json({ error: 'Not found' });

      const b = req.body || {};
      const updates = [];
      const rq = p.request().input('sid', sql.Int, sourceId).input('pid', sql.Int, projectId);

      const textFields = [
        { key: 'authors',            col: 'authors',            type: sql.NVarChar(sql.MAX) },
        { key: 'publication_date',   col: 'publication_date',   type: sql.NVarChar(100) },
        { key: 'article_title',      col: 'article_title',      type: sql.NVarChar(500) },
        { key: 'journal_title',      col: 'journal_title',      type: sql.NVarChar(500) },
        { key: 'volume_number',      col: 'volume_number',      type: sql.NVarChar(50) },
        { key: 'issue_number',       col: 'issue_number',       type: sql.NVarChar(50) },
        { key: 'page_numbers',       col: 'page_numbers',       type: sql.NVarChar(100) },
        { key: 'doi',                col: 'doi',                type: sql.NVarChar(500) },
        { key: 'chapter_name',       col: 'chapter_name',       type: sql.NVarChar(500) },
        { key: 'conference_name',    col: 'conference_name',    type: sql.NVarChar(500) },
        { key: 'source_type',        col: 'source_type',        type: sql.NVarChar(40) },
        { key: 'publisher',          col: 'publisher',          type: sql.NVarChar(500) },
        { key: 'publisher_location', col: 'publisher_location', type: sql.NVarChar(500) },
        { key: 'editors',            col: 'editors',            type: sql.NVarChar(sql.MAX) },
        { key: 'book_title',         col: 'book_title',         type: sql.NVarChar(500) },
        { key: 'url',                col: 'url',                type: sql.NVarChar(1000) },
        { key: 'edition',            col: 'edition',            type: sql.NVarChar(100) },
        { key: 'access_date',        col: 'access_date',        type: sql.NVarChar(100) },
        { key: 'citation_text',      col: 'citation_text',      type: sql.NVarChar(sql.MAX) },
        { key: 'crucible_notes',     col: 'crucible_notes',     type: sql.NVarChar(sql.MAX) },
      ];
      textFields.forEach(function (f) {
        if (b[f.key] !== undefined) {
          const val = b[f.key] != null ? String(b[f.key]).trim() : null;
          updates.push(f.col + ' = @' + f.col);
          rq.input(f.col, f.type, val || null);
        }
      });

      if (updates.length > 0) {
        updates.push('updated_at = GETDATE()');
        const affected = await rq.query(
          `UPDATE sources SET ${updates.join(', ')} WHERE id = @sid AND project_id = @pid`
        );
        if (!affected.rowsAffected[0]) return res.status(404).json({ error: 'Source not found' });
      }

      if (Array.isArray(b.tags)) {
        await p.request().input('sid', sql.Int, sourceId).query('DELETE FROM source_tags WHERE source_id = @sid');
        const tags = b.tags.map(function (t) { return String(t).trim(); }).filter(Boolean);
        for (const tag of tags) {
          await p
            .request()
            .input('source_id', sql.Int, sourceId)
            .input('tag', sql.NVarChar(120), tag.slice(0, 120))
            .query('INSERT INTO source_tags (source_id, tag) VALUES (@source_id, @tag)');
        }
      }

      if (Array.isArray(b.section_ids)) {
        await p.request().input('sid', sql.Int, sourceId).query('DELETE FROM source_sections WHERE source_id = @sid');
        const sectionIds = b.section_ids.map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !Number.isNaN(n); });
        for (const secId of sectionIds) {
          await p
            .request()
            .input('source_id', sql.Int, sourceId)
            .input('section_id', sql.Int, secId)
            .query(
              `IF EXISTS (SELECT 1 FROM project_sections WHERE id = @section_id AND project_id = ${projectId})
               INSERT INTO source_sections (source_id, section_id) VALUES (@source_id, @section_id)`
            );
        }
      }

      const row = await p
        .request()
        .input('id', sql.Int, sourceId)
        .query(
          `SELECT id, project_id, citation_text, notes, crucible_notes, doi,
                  authors, publication_date, article_title, journal_title,
                  volume_number, issue_number, page_numbers, chapter_name, conference_name,
                  source_type, publisher, publisher_location, editors, book_title,
                  url, edition, access_date,
                  sort_order, created_at, updated_at
           FROM sources WHERE id = @id`
        );
      if (!row.recordset[0]) return res.status(404).json({ error: 'Source not found' });

      const tRows = await p.request().input('sid', sql.Int, sourceId)
        .query('SELECT tag FROM source_tags WHERE source_id = @sid');
      const sRows = await p.request().input('sid', sql.Int, sourceId)
        .query('SELECT section_id FROM source_sections WHERE source_id = @sid');

      const source = row.recordset[0];
      source.tags = tRows.recordset.map(function (r) { return r.tag; });
      source.section_ids = sRows.recordset.map(function (r) { return r.section_id; });
      res.json({ source });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/projects/:projectId/sources/:sourceId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sourceId = parseInt(req.params.sourceId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sourceId))
        return res.status(400).json({ error: 'invalid id' });
      const p = await getPool();
      if (!(await ownsProject(p, projectId, req.session.userId)))
        return res.status(404).json({ error: 'Not found' });
      const del = await p
        .request()
        .input('sid', sql.Int, sourceId)
        .input('pid', sql.Int, projectId)
        .query('DELETE FROM sources WHERE id = @sid AND project_id = @pid');
      if (!del.rowsAffected[0]) return res.status(404).json({ error: 'Source not found' });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = createApiRouter;
