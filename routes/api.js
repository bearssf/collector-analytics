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
  PURPOSES,
  CITATION_STYLES,
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
const { isBedrockConfigured, runSectionReview } = require('../lib/bedrockReview');
const { applySuggestionToDraftHtml } = require('../lib/bedrockApplySuggestion');
const { normalizeDoi } = require('../lib/doi');
const { getRelatedReadingSuggestions } = require('../lib/relatedArticles');
const { normalizeTags, replaceSourceTags } = require('../lib/sourceTags');
const { findReferencesSection, findCitedLinkedSources } = require('../lib/citedSources');
const { formatReferenceListHtml } = require('../lib/bedrockReferences');
const { referenceSectionHeadingHtml } = require('../lib/referenceHeading');

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
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

function mapResearchPlanRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    suggestionId: r.suggestion_id,
    sectionId: r.section_id,
    sectionTitle: r.section_title,
    suggestionBody: r.suggestion_body,
    passageExcerpt: r.passage_excerpt,
    keywords: r.keywords,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function requireApiAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function loadSourcesWithSections(getPool, projectId) {
  const p = await getPool();
  const rows = await p
    .request()
    .input('project_id', sql.Int, projectId)
    .query(
      `SELECT s.id, s.project_id, s.citation_text, s.notes, s.crucible_notes, s.doi, s.sort_order, s.created_at, s.updated_at
       FROM sources s WHERE s.project_id = @project_id ORDER BY s.sort_order, s.id`
    );
  const sources = rows.recordset;
  for (const s of sources) {
    const sec = await p
      .request()
      .input('source_id', sql.Int, s.id)
      .query(`SELECT section_id FROM source_sections WHERE source_id = @source_id`);
    s.sectionIds = sec.recordset.map((r) => r.section_id);
    const tr = await p
      .request()
      .input('source_id', sql.Int, s.id)
      .query(`SELECT tag FROM source_tags WHERE source_id = @source_id ORDER BY tag`);
    s.tags = tr.recordset.map((r) => r.tag);
  }
  return sources;
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
      if (body.body !== undefined) {
        updates.push('body = @body');
        reqB.input('body', sql.NVarChar(sql.MAX), body.body != null ? String(body.body) : null);
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
      updates.push('updated_at = GETDATE()');
      await reqB.query(`UPDATE project_sections SET ${updates.join(', ')} WHERE id = @sid`);
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      attachTemplateMeta(bundle);
      res.json(bundle);
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/references/build-from-cited', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      if (!isBedrockConfigured()) {
        return res.status(503).json({
          error:
            'AWS Bedrock is not configured. Set AWS_REGION and an inference profile or model id (see docs/aws-bedrock.md).',
        });
      }
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      const refSection = findReferencesSection(bundle.sections);
      if (!refSection) {
        return res.status(400).json({
          error:
            'No References section found. Use a template with a References section or add one in project settings (slug/title: references).',
        });
      }
      const sources = await loadSourcesWithSections(getPool, projectId);
      const cs =
        bundle.project.citation_style != null
          ? String(bundle.project.citation_style)
          : bundle.project.citationStyle != null
            ? String(bundle.project.citationStyle)
            : 'APA';
      const cited = findCitedLinkedSources(sources, bundle, cs);
      if (!cited.length) {
        return res.status(400).json({
          error:
            'No cited sources found. Link sources to sections in the Crucible, then insert in-text citations (or include citation text) in your draft. The References section text is excluded from detection.',
        });
      }
      let html;
      try {
        html = await formatReferenceListHtml(cited, cs);
      } catch (e) {
        if (e.code === 'BEDROCK_NOT_CONFIGURED') {
          return res.status(503).json({ error: e.message });
        }
        throw e;
      }
      if (!html || !String(html).trim()) {
        return res.status(502).json({ error: 'Model returned an empty reference list.' });
      }
      const fullBody = referenceSectionHeadingHtml(cs) + String(html).trim();
      const p = await getPool();
      const own = await p
        .request()
        .input('sid', sql.Int, refSection.id)
        .input('pid', sql.Int, projectId)
        .input('uid', sql.Int, req.session.userId)
        .query(
          `SELECT ps.id FROM project_sections ps
           INNER JOIN projects pr ON pr.id = ps.project_id
           WHERE ps.id = @sid AND ps.project_id = @pid AND pr.user_id = @uid`
        );
      if (!own.recordset[0]) return res.status(404).json({ error: 'Not found' });
      await p
        .request()
        .input('body', sql.NVarChar(sql.MAX), fullBody)
        .input('sid', sql.Int, refSection.id)
        .query(`UPDATE project_sections SET body = @body, updated_at = GETDATE() WHERE id = @sid`);
      const out = await getProjectBundle(getPool, projectId, req.session.userId);
      attachTemplateMeta(out);
      res.json({
        ok: true,
        citedCount: cited.length,
        referencesSectionId: refSection.id,
        bundle: out,
      });
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
          `SELECT id, project_id, section_id, category, body, suggestion_status, anchor_json, created_at, updated_at
           FROM anvil_suggestions
           WHERE section_id = @section_id AND project_id = @project_id
           ORDER BY created_at DESC`
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

      const created = [];
      for (const it of items) {
        const ins = await p
          .request()
          .input('project_id', sql.Int, projectId)
          .input('section_id', sql.Int, sectionId)
          .input('category', sql.NVarChar(20), it.category)
          .input('body', sql.NVarChar(sql.MAX), it.body)
          .input('anchor_json', sql.NVarChar(500), it.anchorJson)
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
        created.push(mapSuggestionRow(row.recordset[0]));
      }

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
          `SELECT id, project_id, section_id, category, body, suggestion_status, anchor_json, created_at, updated_at
           FROM anvil_suggestions WHERE id = @id`
        );
      res.json({ suggestion: mapSuggestionRow(row.recordset[0]) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId/research-plan', async (req, res, next) => {
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

      const rows = await p.request().input('project_id', sql.Int, projectId).query(
        `SELECT id, project_id, suggestion_id, section_id, section_title, suggestion_body, passage_excerpt, keywords, created_at, updated_at
         FROM research_plan_items WHERE project_id = @project_id ORDER BY created_at DESC`
      );
      res.json({ items: rows.recordset.map(mapResearchPlanRow).filter(Boolean) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/research-plan', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const body = req.body || {};
      const suggestionId = parseInt(body.suggestionId, 10);
      const sectionId = parseInt(body.sectionId, 10);
      if (Number.isNaN(suggestionId) || Number.isNaN(sectionId)) {
        return res.status(400).json({ error: 'suggestionId and sectionId are required' });
      }
      const passageExcerpt = body.passageExcerpt != null ? String(body.passageExcerpt).slice(0, 20000) : null;
      const keywords = body.keywords != null ? String(body.keywords).slice(0, 500) : null;

      const p = await getPool();
      const sugRow = await p
        .request()
        .input('sid', sql.Int, suggestionId)
        .input('pid', sql.Int, projectId)
        .input('sec', sql.Int, sectionId)
        .input('uid', sql.Int, req.session.userId)
        .query(
          `SELECT s.id, s.category, s.body, s.section_id FROM anvil_suggestions s
           INNER JOIN projects pr ON pr.id = s.project_id AND pr.user_id = @uid
           WHERE s.id = @sid AND s.project_id = @pid AND s.section_id = @sec`
        );
      const sug = sugRow.recordset[0];
      if (!sug) return res.status(404).json({ error: 'Suggestion not found' });
      if (String(sug.category || '').toLowerCase() !== 'evidence') {
        return res.status(400).json({ error: 'Only Evidence suggestions can be added to the research plan' });
      }

      const suggestionBody = String(sug.body || '').trim();
      if (!suggestionBody) return res.status(400).json({ error: 'Invalid suggestion' });

      const secRow = await p
        .request()
        .input('section_id', sql.Int, sectionId)
        .input('project_id', sql.Int, projectId)
        .query(`SELECT title FROM project_sections WHERE id = @section_id AND project_id = @project_id`);
      const secTitle = secRow.recordset[0] ? secRow.recordset[0].title : null;

      try {
        const ins = await p
          .request()
          .input('project_id', sql.Int, projectId)
          .input('suggestion_id', sql.Int, suggestionId)
          .input('section_id', sql.Int, sectionId)
          .input('section_title', sql.NVarChar(255), secTitle != null ? String(secTitle).slice(0, 255) : null)
          .input('suggestion_body', sql.NVarChar(sql.MAX), suggestionBody)
          .input('passage_excerpt', sql.NVarChar(sql.MAX), passageExcerpt)
          .input('keywords', sql.NVarChar(500), keywords)
          .query(`
            INSERT INTO research_plan_items (project_id, suggestion_id, section_id, section_title, suggestion_body, passage_excerpt, keywords, updated_at)
            OUTPUT INSERTED.id
            VALUES (@project_id, @suggestion_id, @section_id, @section_title, @suggestion_body, @passage_excerpt, @keywords, GETDATE())
          `);
        const newId = ins.recordset[0].id;
        const row = await p
          .request()
          .input('id', sql.Int, newId)
          .query(
            `SELECT id, project_id, suggestion_id, section_id, section_title, suggestion_body, passage_excerpt, keywords, created_at, updated_at
             FROM research_plan_items WHERE id = @id`
          );
        res.status(201).json({ item: mapResearchPlanRow(row.recordset[0]) });
      } catch (err) {
        const num = err && (err.number || (err.originalError && err.originalError.number));
        if (num === 2627) {
          return res.status(409).json({ error: 'This suggestion is already on your research plan' });
        }
        throw err;
      }
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

  router.post('/projects/:projectId/sections/:sectionId/review', async (req, res, next) => {
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

      const proj = bundle.project || {};
      const citationStyle =
        proj.citation_style != null ? proj.citation_style : proj.citationStyle != null ? proj.citationStyle : 'APA';

      const allSources = await loadSourcesWithSections(getPool, projectId);
      const sourcesForSection = allSources.filter(function (src) {
        const ids = src.sectionIds || [];
        return ids.some(function (x) {
          return Number(x) === sectionId;
        });
      });

      let reviewResult;
      try {
        reviewResult = await runSectionReview({
          html,
          sectionTitle: sec.title,
          citationStyle,
          sourcesForSection,
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

      const items = reviewResult.suggestions || [];
      if (!items.length) {
        return res.json({
          suggestions: [],
          inserted: 0,
          skipped: Boolean(reviewResult.skipped),
          shortDraft: Boolean(reviewResult.shortDraft),
          bedrockConfigured: true,
        });
      }

      const created = await insertAnvilSuggestions(getPool, projectId, sectionId, items);
      res.json({
        suggestions: created,
        inserted: created.length,
        skipped: false,
        bedrockConfigured: true,
      });
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

      const sources = await loadSourcesWithSections(getPool, projectId);
      res.json({ sources });
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId/related-reading', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      const sources = await loadSourcesWithSections(getPool, projectId);
      const RELATED_MS = 170000;
      const result = await Promise.race([
        getRelatedReadingSuggestions({ project: bundle.project, sources }),
        new Promise((_, reject) => {
          setTimeout(function () {
            reject(Object.assign(new Error('RELATED_READING_TIMEOUT'), { code: 'TIMEOUT' }));
          }, RELATED_MS);
        }),
      ]);
      if (!result.ok) {
        return res.status(400).json({
          error: result.message || 'Cannot suggest related reading',
          code: result.code || 'BAD_REQUEST',
        });
      }
      res.json(result);
    } catch (e) {
      if (e && e.message === 'RELATED_READING_TIMEOUT') {
        return res.status(504).json({
          error:
            'Related reading took too long (Semantic Scholar + optional Bedrock). Try again in a minute or set SEMANTIC_SCHOLAR_API_KEY.',
          code: 'GATEWAY_TIMEOUT',
        });
      }
      next(e);
    }
  });

  router.post('/projects/:projectId/sources', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid project id' });
      const { citationText, notes, crucibleNotes, sectionIds, doi, tags } = req.body || {};
      if (!citationText || !String(citationText).trim()) return res.status(400).json({ error: 'citationText is required' });
      const doiNorm = normalizeDoi(doi);
      const tagsNorm = normalizeTags(tags);
      const p = await getPool();
      const own = await p
        .request()
        .input('id', sql.Int, projectId)
        .input('user_id', sql.Int, req.session.userId)
        .query('SELECT id FROM projects WHERE id = @id AND user_id = @user_id');
      if (!own.recordset[0]) return res.status(404).json({ error: 'Not found' });

      const crucibleNotesVal =
        crucibleNotes != null && String(crucibleNotes).trim() !== '' ? String(crucibleNotes) : null;
      const ins = await p
        .request()
        .input('project_id', sql.Int, projectId)
        .input('citation_text', sql.NVarChar(sql.MAX), String(citationText).trim())
        .input('notes', sql.NVarChar(sql.MAX), notes != null ? String(notes) : null)
        .input('crucible_notes', sql.NVarChar(sql.MAX), crucibleNotesVal)
        .input('doi', sql.NVarChar(500), doiNorm)
        .query(`
          INSERT INTO sources (project_id, citation_text, notes, crucible_notes, doi, updated_at)
          OUTPUT INSERTED.id
          VALUES (@project_id, @citation_text, @notes, @crucible_notes, @doi, GETDATE())
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

      await replaceSourceTags(p, sourceId, tagsNorm);

      const row = await p
        .request()
        .input('id', sql.Int, sourceId)
        .query(
          `SELECT id, project_id, citation_text, notes, crucible_notes, doi, sort_order, created_at, updated_at FROM sources WHERE id = @id`
        );
      const out = row.recordset[0];
      const sec = await p
        .request()
        .input('source_id', sql.Int, sourceId)
        .query(`SELECT section_id FROM source_sections WHERE source_id = @source_id`);
      out.sectionIds = sec.recordset.map((r) => r.section_id);
      out.tags = tagsNorm;
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
      if (body.crucibleNotes !== undefined) {
        updates.push('crucible_notes = @crucible_notes');
        reqB.input(
          'crucible_notes',
          sql.NVarChar(sql.MAX),
          body.crucibleNotes != null ? String(body.crucibleNotes) : null
        );
      }
      if (body.doi !== undefined) {
        updates.push('doi = @doi');
        reqB.input('doi', sql.NVarChar(500), normalizeDoi(body.doi));
      }
      if (body.sortOrder !== undefined) {
        updates.push('sort_order = @sort_order');
        reqB.input('sort_order', sql.Int, parseInt(body.sortOrder, 10));
      }
      if (
        updates.length === 0 &&
        !Array.isArray(body.sectionIds) &&
        body.tags === undefined
      ) {
        return res.status(400).json({ error: 'No valid fields' });
      }
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

      if (Array.isArray(body.tags)) {
        const tagsNorm = normalizeTags(body.tags);
        const pool = await getPool();
        await replaceSourceTags(pool, sourceId, tagsNorm);
        await p.request().input('sid', sql.Int, sourceId).query(`UPDATE sources SET updated_at = GETDATE() WHERE id = @sid`);
      }

      const row = await p
        .request()
        .input('id', sql.Int, sourceId)
        .query(
          `SELECT id, project_id, citation_text, notes, crucible_notes, doi, sort_order, created_at, updated_at FROM sources WHERE id = @id`
        );
      const out = row.recordset[0];
      const sec = await p
        .request()
        .input('source_id', sql.Int, sourceId)
        .query(`SELECT section_id FROM source_sections WHERE source_id = @source_id`);
      out.sectionIds = sec.recordset.map((r) => r.section_id);
      const tr = await p
        .request()
        .input('source_id', sql.Int, sourceId)
        .query(`SELECT tag FROM source_tags WHERE source_id = @source_id ORDER BY tag`);
      out.tags = tr.recordset.map((r) => r.tag);
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
