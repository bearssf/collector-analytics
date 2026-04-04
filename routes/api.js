const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { query, queryRaw } = require('../lib/db');
const bcrypt = require('bcryptjs');
const { ensureSubscriptionRow, getSubscriptionRow, appAccessFromRow } = require('../lib/subscriptions');
const {
  normalizeTitleToKey,
  normalizeSearchEngineToKey,
  isAllowedTitleKey,
  isAllowedSearchEngineKey,
} = require('../lib/canonicalSelects');
const { getUserProfileRow, rowToPublicUser } = require('../lib/userProfile');
const i18n = require('../lib/i18n');
const {
  loadTemplates,
  listProjects,
  getProjectBundle,
  createProject,
  updateProjectSettings,
  deleteProject,
  cancelProject,
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
const { isBedrockConfigured, invokeClaudeMessages } = require('../lib/bedrockReview');
const { runStructuredSectionReview } = require('../lib/bedrockStructuredReview');
const { applySuggestionToDraftHtml } = require('../lib/bedrockApplySuggestion');
const { searchPapers } = require('../lib/semanticScholar');
const { markPageCompleted, resetPageCompletion } = require('../lib/trainingWalkthrough');

function tReq(req, key, vars) {
  return i18n.t((req && req.locale) || 'en', key, vars);
}

function apiErr(req, res, status, key, vars) {
  return res.status(status).json({ error: tReq(req, key, vars) });
}

function isAbstractSectionSlug(slug) {
  return String(slug || '')
    .trim()
    .toLowerCase() === 'abstract';
}

/** Omit evidence-category items for the abstract section (slug `abstract`). */
function filterStructuredFeedbackItemsForAbstract(items, sectionSlug) {
  if (!isAbstractSectionSlug(sectionSlug) || !Array.isArray(items)) return items;
  return items.filter(function (it) {
    return String(it.category || '').trim().toLowerCase() !== 'evidence';
  });
}

function mapQualityCategory(cat) {
  var c = (cat || '').toLowerCase();
  if (c === 'spelling' || c === 'formatting') return 'grammar';
  return c;
}

function qualityTierFromPercent(p) {
  var n = Number(p);
  if (Number.isNaN(n)) return 'strong';
  if (n > 75) return 'strong';
  if (n >= 51) return 'moderate';
  return 'poor';
}

function clampQualityPercent(x) {
  var n = Number(x);
  if (Number.isNaN(n)) return 100;
  return Math.max(0, Math.min(100, n));
}

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
  if (!req.session.userId) return apiErr(req, res, 401, 'errors.unauthorized');
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
            return apiErr(req, res, 400, 'errors.fileTooLarge');
          }
          if (err.message === 'Only image files are allowed.') {
            return apiErr(req, res, 400, 'errors.onlyImageFiles');
          }
          return res.status(400).json({ error: err.message || tReq(req, 'errors.uploadFailed') });
        }
        next();
      });
    },
    async function (req, res, next) {
      try {
        const projectId = parseInt(req.params.projectId, 10);
        if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
        const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
        if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
        if (!req.file) return apiErr(req, res, 400, 'errors.noImageFile');
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
      const titleRaw = (body.title || '').trim();
      const title = normalizeTitleToKey(titleRaw) || titleRaw;
      const firstName = (body.firstName || '').trim();
      const lastName = (body.lastName || '').trim();
      const university = (body.university || '').trim();
      const researchFocus = (body.researchFocus || '').trim();
      const preferredSearchEngineRaw = (body.preferredSearchEngine || '').trim();
      const preferredSearchEngine =
        normalizeSearchEngineToKey(preferredSearchEngineRaw) || preferredSearchEngineRaw;
      const preferredLocaleRaw = body.preferredLocale;
      const hasPreferredLocale =
        preferredLocaleRaw !== undefined &&
        preferredLocaleRaw !== null &&
        String(preferredLocaleRaw).trim() !== '';

      if (!title || !isAllowedTitleKey(title)) {
        return apiErr(req, res, 400, 'errors.invalidTitle');
      }
      if (!firstName || !lastName) {
        return apiErr(req, res, 400, 'errors.nameRequired');
      }
      if (preferredSearchEngine && !isAllowedSearchEngineKey(preferredSearchEngine)) {
        return apiErr(req, res, 400, 'errors.invalidSearchEngine');
      }

      const preferredLocale = hasPreferredLocale
        ? i18n.normalizeLocale(preferredLocaleRaw)
        : null;

      await query(
        getPool,
        `UPDATE users SET
            title = @title,
            first_name = @first_name,
            last_name = @last_name,
            university = @university,
            research_focus = @research_focus,
            preferred_search_engine = @preferred_search_engine
            ${preferredLocale != null ? ', preferred_locale = @preferred_locale' : ''}
           WHERE id = @id`,
        {
          id: req.session.userId,
          title,
          first_name: firstName,
          last_name: lastName,
          university: university || null,
          research_focus: researchFocus || null,
          preferred_search_engine: preferredSearchEngine || null,
          ...(preferredLocale != null ? { preferred_locale: preferredLocale } : {}),
        }
      );

      if (preferredLocale != null) {
        req.session.locale = preferredLocale;
        i18n.setLocaleCookie(res, preferredLocale);
      }

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
        return apiErr(req, res, 400, 'errors.currentPasswordRequired');
      }
      if (newPassword.length < 8) {
        return apiErr(req, res, 400, 'errors.passwordMinLength');
      }
      if (newPassword !== confirmPassword) {
        return apiErr(req, res, 400, 'errors.passwordMismatch');
      }

      const r = await query(getPool, 'SELECT password_hash FROM users WHERE id = @id', {
        id: req.session.userId,
      });
      const row = r.recordset[0];
      if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
        return apiErr(req, res, 400, 'errors.currentPasswordIncorrect');
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await query(getPool, 'UPDATE users SET password_hash = @password_hash WHERE id = @id', {
        id: req.session.userId,
        password_hash: hash,
      });

      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/me/research-ideas', async (req, res, next) => {
    try {
      const b = req.body || {};
      const researchTopic = String(b.researchTopic || b.research_topic || '').trim();
      if (!researchTopic) {
        return apiErr(req, res, 400, 'errors.researchTopicRequired');
      }
      const keywords = b.keywords != null ? String(b.keywords).trim().slice(0, 500) : null;
      const notes = b.notes != null ? String(b.notes).slice(0, 20000) : null;
      await query(
        getPool,
        `INSERT INTO user_research_ideas (user_id, research_topic, keywords, notes)
         VALUES (@user_id, @research_topic, @keywords, @notes)`,
        {
          user_id: req.session.userId,
          research_topic: researchTopic.slice(0, 500),
          keywords,
          notes,
        }
      );
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/me/training/complete', async (req, res, next) => {
    try {
      const pageSlug = String((req.body && req.body.pageSlug) || '').trim().slice(0, 80);
      if (!pageSlug) return apiErr(req, res, 400, 'errors.pageSlugRequired');
      await markPageCompleted(getPool, req.session.userId, pageSlug);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/me/training/reset', async (req, res, next) => {
    try {
      const pageSlug = String((req.body && req.body.pageSlug) || '').trim().slice(0, 80);
      if (!pageSlug) return apiErr(req, res, 400, 'errors.pageSlugRequired');
      await resetPageCompletion(getPool, req.session.userId, pageSlug);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/me/published-work', async (req, res, next) => {
    try {
      const b = req.body || {};
      const title = String(b.title || '').trim();
      if (!title) {
        return apiErr(req, res, 400, 'errors.titleRequired');
      }
      const datePublished = b.datePublished != null ? String(b.datePublished).trim().slice(0, 100) : null;
      const wherePublished = b.wherePublished != null ? String(b.wherePublished).trim().slice(0, 500) : null;
      const link = b.link != null ? String(b.link).trim().slice(0, 1000) : null;
      await query(
        getPool,
        `INSERT INTO user_published_work (user_id, title, date_published, where_published, link)
         VALUES (@user_id, @title, @date_published, @where_published, @link)`,
        {
          user_id: req.session.userId,
          title: title.slice(0, 500),
          date_published: datePublished,
          where_published: wherePublished,
          link,
        }
      );
      res.status(201).json({ ok: true });
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
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
      attachTemplateMeta(bundle);
      res.json(bundle);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/projects/:projectId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const result = await deleteProject(getPool, req.session.userId, projectId);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/cancel', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const result = await cancelProject(getPool, req.session.userId, projectId);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const preBundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!preBundle) return apiErr(req, res, 404, 'errors.notFound');
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
      const pubParams = { id: projectId, user_id: req.session.userId };
      if (body.status !== undefined) {
        updates.push('status = @status');
        pubParams.status = body.status;
      }
      ['publishing_title', 'publishing_venue', 'publishing_disposition'].forEach((k) => {
        if (body[k] !== undefined) {
          updates.push(`${k} = @${k}`);
          pubParams[k] = body[k];
        }
      });
      if (body.publishing_submitted_at !== undefined) {
        updates.push('publishing_submitted_at = @publishing_submitted_at');
        pubParams.publishing_submitted_at = body.publishing_submitted_at
          ? new Date(body.publishing_submitted_at)
          : null;
      }
      if (body.publishing_published_at !== undefined) {
        updates.push('publishing_published_at = @publishing_published_at');
        pubParams.publishing_published_at = body.publishing_published_at
          ? new Date(body.publishing_published_at)
          : null;
      }
      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        const sqlText = `UPDATE projects SET ${updates.join(', ')} WHERE id = @id AND user_id = @user_id`;
        const r = await query(getPool, sqlText, pubParams);
        if (r.rowsAffected[0] === 0) return apiErr(req, res, 404, 'errors.notFound');
      } else if (!hasMeta) {
        return apiErr(req, res, 400, 'errors.noValidFieldsToUpdate');
      }

      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
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
      if (Number.isNaN(projectId) || Number.isNaN(sectionId)) return apiErr(req, res, 400, 'errors.invalidId');
      const body = req.body || {};
      const own = await query(
        getPool,
        `SELECT ps.id FROM project_sections ps
         INNER JOIN projects pr ON pr.id = ps.project_id
         WHERE ps.id = @sid AND ps.project_id = @pid AND pr.user_id = @user_id
         AND LOWER(COALESCE(pr.status, '')) <> 'canceled'`,
        { sid: sectionId, pid: projectId, user_id: req.session.userId }
      );
      if (!own.recordset[0]) return apiErr(req, res, 404, 'errors.notFound');

      const updates = [];
      const secParams = { sid: sectionId };
      if (body.status !== undefined) {
        updates.push('status = @status');
        secParams.status = body.status;
      }
      if (body.progressPercent !== undefined) {
        updates.push('progress_percent = @progress_percent');
        const pp = parseInt(body.progressPercent, 10);
        secParams.progress_percent = Math.min(100, Math.max(0, Number.isNaN(pp) ? 0 : pp));
      }
      if (body.title !== undefined) {
        updates.push('title = @title');
        secParams.title = String(body.title).trim();
      }
      let bodyChanged = false;
      if (body.body !== undefined) {
        updates.push('body = @body');
        secParams.body = body.body != null ? String(body.body) : null;
        if (staleFeedbackEnabled()) {
          updates.push('draft_revision = draft_revision + 1');
        }
        bodyChanged = true;
      }
      if (updates.length === 0) return apiErr(req, res, 400, 'errors.noValidFields');
      updates.push('updated_at = NOW()');
      await query(getPool, `UPDATE project_sections SET ${updates.join(', ')} WHERE id = @sid`, secParams);
      let invalidatedOpen = 0;
      if (staleFeedbackEnabled() && bodyChanged) {
        const revRow = await query(
          getPool,
          `SELECT draft_revision FROM project_sections WHERE id = @sid AND project_id = @pid`,
          { sid: sectionId, pid: projectId }
        );
        const newRev =
          revRow.recordset[0] && revRow.recordset[0].draft_revision != null
            ? Number(revRow.recordset[0].draft_revision)
            : 0;
        const del = await query(
          getPool,
          `DELETE FROM anvil_suggestions WHERE section_id = @sid AND project_id = @pid
           AND suggestion_status = 'open' AND COALESCE(draft_revision_at_generation, -1) < @rev`,
          { sid: sectionId, pid: projectId, rev: newRev }
        );
        invalidatedOpen = del.rowsAffected && del.rowsAffected[0] ? del.rowsAffected[0] : 0;
      }
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
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
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const format = String(req.query.format || '').toLowerCase();
      if (format !== 'txt' && format !== 'docx') {
        return apiErr(req, res, 400, 'errors.exportFormatInvalid');
      }
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
      const projectName = bundle.project.name || 'Project';
      const sections = (bundle.sections || []).map(function (s) {
        return {
          title: s.title,
          body: s.body != null ? String(s.body) : '',
          slug: s.slug != null ? String(s.slug) : '',
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
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
      const body = req.body || {};
      const sectionsIn = Array.isArray(body.sections) ? body.sections : [];
      if (!sectionsIn.length) {
        return apiErr(req, res, 400, 'errors.sectionsArrayRequired');
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
          slug: s.slug != null ? String(s.slug) : '',
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
        return apiErr(req, res, 400, 'errors.invalidId');
      }
      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
      const sec = bundle.sections.find(function (s) {
        return Number(s.id) === sectionId;
      });
      if (!sec) return apiErr(req, res, 404, 'errors.sectionNotFound');
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
      const sectionSlug =
        body.sectionSlug != null
          ? String(body.sectionSlug).trim().toLowerCase()
          : sec.slug != null
            ? String(sec.slug).trim().toLowerCase()
            : '';
      const buf = await buildSectionDocxBuffer({ title, html, citationStyle, sectionSlug });
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
        return apiErr(req, res, 400, 'errors.invalidId');
      }
      const own = await query(
        getPool,
        `SELECT ps.id FROM project_sections ps
         INNER JOIN projects pr ON pr.id = ps.project_id
         WHERE ps.id = @sid AND ps.project_id = @pid AND pr.user_id = @user_id
         AND LOWER(COALESCE(pr.status, '')) <> 'canceled'`,
        { sid: sectionId, pid: projectId, user_id: req.session.userId }
      );
      if (!own.recordset[0]) return apiErr(req, res, 404, 'errors.notFound');

      const rows = await query(
        getPool,
        `SELECT s.id, s.project_id, s.section_id, s.category, s.body, s.suggestion_status, s.anchor_json,
                s.draft_revision_at_generation, ps.draft_revision AS section_draft_revision,
                s.created_at, s.updated_at
         FROM anvil_suggestions s
         INNER JOIN project_sections ps ON ps.id = s.section_id AND ps.project_id = s.project_id
         WHERE s.section_id = @section_id AND s.project_id = @project_id
         ORDER BY s.created_at DESC`,
        { section_id: sectionId, project_id: projectId }
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
        return apiErr(req, res, 400, 'errors.invalidId');
      }
      const own = await query(
        getPool,
        `SELECT ps.id FROM project_sections ps
         INNER JOIN projects pr ON pr.id = ps.project_id
         WHERE ps.id = @sid AND ps.project_id = @pid AND pr.user_id = @user_id
         AND LOWER(COALESCE(pr.status, '')) <> 'canceled'`,
        { sid: sectionId, pid: projectId, user_id: req.session.userId }
      );
      if (!own.recordset[0]) return apiErr(req, res, 404, 'errors.notFound');

      const body = req.body || {};
      const items = [];
      if (Array.isArray(body.suggestions)) {
        for (const raw of body.suggestions) {
          const cat = normalizeCategory(raw && raw.category);
          const text = raw && raw.body != null ? String(raw.body).trim() : '';
          if (!cat || !text) {
            return apiErr(req, res, 400, 'errors.suggestionCategoryBody');
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
        if (!cat || !text) return apiErr(req, res, 400, 'errors.categoryBodyRequired');
        items.push({
          category: cat,
          body: text,
          anchorJson: body.anchorJson != null ? String(body.anchorJson).slice(0, 500) : null,
        });
      }

      if (items.length === 0) return apiErr(req, res, 400, 'errors.noSuggestionsToSave');

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
        return apiErr(req, res, 400, 'errors.invalidId');
      }
      const body = req.body || {};
      const newStatus = body.status != null ? String(body.status).toLowerCase() : '';
      if (!isValidStatus(newStatus) || newStatus === 'open') {
        return apiErr(req, res, 400, 'errors.suggestionStatusInvalid');
      }

      const upd = await query(
        getPool,
        `UPDATE anvil_suggestions AS sug
         INNER JOIN projects AS pr ON pr.id = sug.project_id
         SET sug.suggestion_status = @suggestion_status, sug.updated_at = NOW()
         WHERE sug.id = @sid AND sug.project_id = @pid AND pr.user_id = @user_id`,
        {
          sid: suggestionId,
          pid: projectId,
          user_id: req.session.userId,
          suggestion_status: newStatus,
        }
      );
      if (!upd.rowsAffected || !upd.rowsAffected[0]) return apiErr(req, res, 404, 'errors.notFound');

      const row = await query(
        getPool,
        `SELECT id, project_id, section_id, category, body, suggestion_status, anchor_json, draft_revision_at_generation, created_at, updated_at
         FROM anvil_suggestions WHERE id = @id`,
        { id: suggestionId }
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
            error: tReq(req, 'errors.bedrockNotConfigured'),
            bedrockConfigured: false,
          });
        }

        const projectId = parseInt(req.params.projectId, 10);
        const sectionId = parseInt(req.params.sectionId, 10);
        const suggestionId = parseInt(req.params.suggestionId, 10);
        if (Number.isNaN(projectId) || Number.isNaN(sectionId) || Number.isNaN(suggestionId)) {
          return apiErr(req, res, 400, 'errors.invalidId');
        }

        const body = req.body || {};
        const html = body.html != null ? String(body.html) : '';
        if (!html.trim()) {
          return apiErr(req, res, 400, 'errors.htmlRequired');
        }

        const rowRes = await query(
          getPool,
          `SELECT sug.id, sug.body, sug.suggestion_status, ps.title AS section_title
           FROM anvil_suggestions AS sug
           INNER JOIN projects AS pr ON pr.id = sug.project_id AND pr.user_id = @user_id
           INNER JOIN project_sections AS ps ON ps.id = sug.section_id AND ps.project_id = sug.project_id
           WHERE sug.id = @sid AND sug.section_id = @sec AND sug.project_id = @pid`,
          {
            sid: suggestionId,
            sec: sectionId,
            pid: projectId,
            user_id: req.session.userId,
          }
        );

        const row = rowRes.recordset[0];
        if (!row) return apiErr(req, res, 404, 'errors.notFound');

        const st = row.suggestion_status != null ? String(row.suggestion_status).toLowerCase() : 'open';
        if (st !== 'open') {
          return apiErr(req, res, 400, 'errors.suggestionNotOpen');
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
          return apiErr(req, res, 400, 'errors.suggestionNoText');
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
          let msg = err && err.message ? String(err.message) : tReq(req, 'errors.bedrockRequestFailed');
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

  /** The Anvil: structured anchor-based feedback — persists to anvil_feedback table. */
  router.post('/projects/:projectId/sections/:sectionId/review-structured', async (req, res, next) => {
    try {
      if (!isBedrockConfigured()) {
        return res.status(503).json({
          error: tReq(req, 'errors.bedrockNotConfigured'),
          bedrockConfigured: false,
        });
      }

      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId)) {
        return apiErr(req, res, 400, 'errors.invalidId');
      }

      const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
      if (!bundle) return apiErr(req, res, 404, 'errors.notFound');
      const sec = bundle.sections.find(function (s) {
        return Number(s.id) === sectionId;
      });
      if (!sec) return apiErr(req, res, 404, 'errors.sectionNotFound');

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
          sectionSlug: sec.slug,
          outputLanguage: req.languageNameForAi,
        });
      } catch (err) {
        let msg = err && err.message ? String(err.message) : tReq(req, 'errors.bedrockRequestFailed');
        if (err && err.name === 'AccessDeniedException') {
          msg = 'Bedrock access denied — check IAM permissions and model access in this region.';
        } else if (/inference profile/i.test(msg) && /on-demand|throughput/i.test(msg)) {
          msg +=
            ' Set BEDROCK_INFERENCE_PROFILE_ARN (recommended) or put the inference profile id/ARN in BEDROCK_MODEL_ID — see docs/aws-bedrock.md.';
        }
        return res.status(502).json({ error: msg, bedrockConfigured: true });
      }

      if (reviewResult.skipped || reviewResult.shortDraft) {
        return res.json({
          items: [],
          skipped: true,
          shortDraft: Boolean(reviewResult.shortDraft),
          bedrockConfigured: true,
        });
      }

      const newItems = filterStructuredFeedbackItemsForAbstract(reviewResult.items || [], sec.slug);

      const existing = await query(
        getPool,
        `SELECT id, fb_id, category, anchor_text, status
         FROM anvil_feedback
         WHERE project_id = @pid AND section_id = @sid`,
        { pid: projectId, sid: sectionId }
      );

      const existingSet = new Set();
      for (const row of existing.recordset) {
        existingSet.add((row.anchor_text || '').toLowerCase() + '||' + (row.category || '').toLowerCase());
      }

      let insertedCount = 0;
      for (const it of newItems) {
        const key = (it.anchorText || '').toLowerCase() + '||' + (it.category || '').toLowerCase();
        if (existingSet.has(key)) continue;
        existingSet.add(key);
        const awc = countWordsPlain(it.anchorText);
        await query(
          getPool,
          `INSERT INTO anvil_feedback
            (project_id, section_id, fb_id, category, anchor_text, context_before, context_after,
             suggestion, rationale, is_actionable, status, anchor_word_count)
           VALUES
            (@pid, @sid, @fb_id, @category, @anchor_text, @context_before, @context_after,
             @suggestion, @rationale, @is_actionable, 'active', @awc)`,
          {
            pid: projectId,
            sid: sectionId,
            fb_id: String(it.id || '').slice(0, 100),
            category: String(it.category || '').slice(0, 50),
            anchor_text: it.anchorText || '',
            context_before: (it.contextBefore || '').slice(0, 500),
            context_after: (it.contextAfter || '').slice(0, 500),
            suggestion: it.suggestion || '',
            rationale: it.rationale || '',
            is_actionable: it.isActionable ? 1 : 0,
            awc,
          }
        );
        insertedCount++;
      }

      const allRows = await query(
        getPool,
        `SELECT id, project_id, section_id, fb_id, category, anchor_text,
                context_before, context_after, suggestion, rationale,
                is_actionable, status, anchor_word_count, created_at, updated_at
         FROM anvil_feedback
         WHERE project_id = @pid AND section_id = @sid
         ORDER BY created_at DESC`,
        { pid: projectId, sid: sectionId }
      );
      let allItems = allRows.recordset.map(function (r) {
        return {
          dbId: r.id,
          id: r.fb_id,
          category: r.category,
          anchorText: r.anchor_text,
          contextBefore: r.context_before || '',
          contextAfter: r.context_after || '',
          suggestion: r.suggestion || '',
          rationale: r.rationale || '',
          isActionable: !!r.is_actionable,
          status: r.status || 'active',
          anchorWordCount: r.anchor_word_count || 0,
        };
      });
      allItems = filterStructuredFeedbackItemsForAbstract(allItems, sec.slug);

      await query(
        getPool,
        `UPDATE project_sections
         SET structured_review_at = COALESCE(structured_review_at, NOW(6)), updated_at = NOW(6)
         WHERE id = @sid AND project_id = @pid`,
        { sid: sectionId, pid: projectId }
      );
      const srRow = await query(
        getPool,
        `SELECT structured_review_at FROM project_sections WHERE id = @sid AND project_id = @pid`,
        { sid: sectionId, pid: projectId }
      );
      const sra = srRow.recordset[0] && srRow.recordset[0].structured_review_at;
      let structuredReviewAt = null;
      if (sra) {
        structuredReviewAt = sra instanceof Date ? sra.toISOString() : String(sra);
      }

      res.json({
        items: allItems,
        skipped: false,
        shortDraft: false,
        bedrockConfigured: true,
        inserted: insertedCount,
        structuredReviewAt,
      });
    } catch (e) {
      next(e);
    }
  });

  /* ── Anvil feedback persistence ───────────────────────────────────── */

  function countWordsPlain(text) {
    if (!text) return 0;
    var t = String(text).replace(/\s+/g, ' ').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  router.get('/projects/:projectId/sections/:sectionId/feedback', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId))
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const secSlugRow = await query(
        getPool,
        `SELECT slug FROM project_sections WHERE id = @sid AND project_id = @pid`,
        { sid: sectionId, pid: projectId }
      );
      const sectionSlug = secSlugRow.recordset[0] && secSlugRow.recordset[0].slug;

      const rows = await query(
        getPool,
        `SELECT id, project_id, section_id, fb_id, category, anchor_text,
                context_before, context_after, suggestion, rationale,
                is_actionable, status, anchor_word_count, created_at, updated_at
         FROM anvil_feedback
         WHERE project_id = @pid AND section_id = @sid
         ORDER BY created_at DESC`,
        { pid: projectId, sid: sectionId }
      );
      let items = rows.recordset.map(function (r) {
        return {
          dbId: r.id,
          id: r.fb_id,
          category: r.category,
          anchorText: r.anchor_text,
          contextBefore: r.context_before || '',
          contextAfter: r.context_after || '',
          suggestion: r.suggestion || '',
          rationale: r.rationale || '',
          isActionable: !!r.is_actionable,
          status: r.status || 'active',
          anchorWordCount: r.anchor_word_count || 0,
        };
      });
      items = filterStructuredFeedbackItemsForAbstract(items, sectionSlug);
      res.json({ items });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId/feedback/:itemId/status', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const itemId = parseInt(req.params.itemId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(itemId))
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const newStatus = (req.body.status || '').trim().toLowerCase();
      const allowed = ['active', 'applied', 'dismissed', 'resolved', 'pending'];
      if (!allowed.includes(newStatus))
        return apiErr(req, res, 400, 'errors.invalidStatus');

      const upd = await query(
        getPool,
        `UPDATE anvil_feedback
         SET status = @status, updated_at = NOW()
         WHERE id = @id AND project_id = @pid`,
        { id: itemId, pid: projectId, status: newStatus }
      );
      if (!upd.rowsAffected[0]) return apiErr(req, res, 404, 'errors.itemNotFound');
      res.json({ ok: true, status: newStatus });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/sections/:sectionId/feedback/rebase', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sectionId = parseInt(req.params.sectionId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sectionId))
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const plainText = req.body.plainText != null ? String(req.body.plainText) : '';
      const secSlugRow = await query(
        getPool,
        `SELECT slug FROM project_sections WHERE id = @sid AND project_id = @pid`,
        { sid: sectionId, pid: projectId }
      );
      const sectionSlug = secSlugRow.recordset[0] && secSlugRow.recordset[0].slug;

      const rows = await query(
        getPool,
        `SELECT id, anchor_text, suggestion, status
         FROM anvil_feedback
         WHERE project_id = @pid AND section_id = @sid`,
        { pid: projectId, sid: sectionId }
      );

      const staleIds = [];
      for (const r of rows.recordset) {
        if (r.status === 'applied' || r.status === 'dismissed' || r.status === 'resolved') continue;
        const anchor = r.anchor_text || '';
        if (!anchor || !plainText.includes(anchor)) {
          const sug = (r.suggestion || '').trim();
          if (sug && plainText.includes(sug)) continue;
          staleIds.push(r.id);
        }
      }
      if (staleIds.length) {
        await queryRaw(
          getPool,
          `DELETE FROM anvil_feedback WHERE id IN (${staleIds.join(',')})`
        );
      }

      const remaining = await query(
        getPool,
        `SELECT id, project_id, section_id, fb_id, category, anchor_text,
                context_before, context_after, suggestion, rationale,
                is_actionable, status, anchor_word_count, created_at, updated_at
         FROM anvil_feedback
         WHERE project_id = @pid AND section_id = @sid
         ORDER BY created_at DESC`,
        { pid: projectId, sid: sectionId }
      );
      let items = remaining.recordset.map(function (r) {
        return {
          dbId: r.id,
          id: r.fb_id,
          category: r.category,
          anchorText: r.anchor_text,
          contextBefore: r.context_before || '',
          contextAfter: r.context_after || '',
          suggestion: r.suggestion || '',
          rationale: r.rationale || '',
          isActionable: !!r.is_actionable,
          status: r.status || 'active',
          anchorWordCount: r.anchor_word_count || 0,
        };
      });
      items = filterStructuredFeedbackItemsForAbstract(items, sectionSlug);
      res.json({ items, removed: staleIds.length });
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId/feedback-scores', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const wordRows = await query(
        getPool,
        `SELECT id, body FROM project_sections WHERE project_id = @pid`,
        { pid: projectId }
      );
      let totalProjectWords = 0;
      for (const wr of wordRows.recordset) {
        const text = wr.body ? String(wr.body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
        const wc = text ? text.split(/\s+/).length : 0;
        totalProjectWords += wc;
      }

      const openFeedback = await query(
        getPool,
        `SELECT f.category, f.anchor_word_count, ps.slug AS section_slug
         FROM anvil_feedback f
         INNER JOIN project_sections ps ON ps.id = f.section_id AND ps.project_id = f.project_id
         WHERE f.project_id = @pid AND f.status IN ('active','pending')`,
        { pid: projectId }
      );

      var deductions = { logic: 0, clarity: 0, evidence: 0, grammar: 0 };
      if (totalProjectWords > 0) {
        for (const row of openFeedback.recordset) {
          var mapped = mapQualityCategory(row.category);
          if (deductions[mapped] === undefined) continue;
          if (isAbstractSectionSlug(row.section_slug) && mapped === 'evidence') continue;
          var aw = row.anchor_word_count || 0;
          deductions[mapped] += (aw / totalProjectWords) * 100;
        }
      }

      var project = {};
      ['logic', 'clarity', 'evidence', 'grammar'].forEach(function (cat) {
        var pct = clampQualityPercent(100 - deductions[cat]);
        project[cat] = {
          percent: Math.round(pct),
          rating: qualityTierFromPercent(pct),
        };
      });

      res.json({ project });
    } catch (e) {
      next(e);
    }
  });

  /* ── Bedrock keyword extraction for S2 search ─────────────────────── */

  router.post('/projects/:projectId/sources/extract-keywords', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const own = await query(
        getPool,
        'SELECT id FROM projects WHERE id = @id AND user_id = @user_id',
        { id: projectId, user_id: req.session.userId }
      );
      if (!own.recordset[0]) return apiErr(req, res, 404, 'errors.notFound');

      if (!isBedrockConfigured()) {
        return apiErr(req, res, 503, 'errors.aiKeywordsNotConfigured');
      }

      const titles = Array.isArray(req.body.titles) ? req.body.titles.filter(Boolean) : [];
      const tags = Array.isArray(req.body.tags) ? req.body.tags.filter(Boolean) : [];
      if (!titles.length && !tags.length) {
        return apiErr(req, res, 400, 'errors.titleOrTagRequired');
      }

      const prompt =
        'You are an academic research assistant. Given the following article titles and user-assigned tags from a research project, ' +
        'extract the best search keywords to find related academic papers on Semantic Scholar.\n\n' +
        'Requirements:\n' +
        '- Return 8 to 15 keywords or short phrases (2-3 words max each).\n' +
        '- Focus on the core academic concepts, methodologies, and subject areas.\n' +
        '- Include broader field terms and specific technical terms.\n' +
        '- Do NOT include common stop words, author names, or generic terms like "study" or "analysis".\n' +
        '- Return ONLY a JSON array of strings, no explanation or markdown.\n\n' +
        'Article titles:\n' + titles.map(function (t) { return '- ' + t; }).join('\n') + '\n\n' +
        'User tags:\n' + (tags.length ? tags.map(function (t) { return '- ' + t; }).join('\n') : '(none)') + '\n\n' +
        'Return a JSON array of keyword strings:';

      console.log('[Bedrock Keywords] Requesting keywords for', titles.length, 'titles,', tags.length, 'tags');
      const raw = await invokeClaudeMessages(prompt, { maxTokens: 512, temperature: 0.3 });

      let keywords;
      try {
        const match = raw.match(/\[[\s\S]*\]/);
        keywords = match ? JSON.parse(match[0]) : [];
      } catch (e) {
        console.error('[Bedrock Keywords] Failed to parse response:', raw.slice(0, 300));
        return apiErr(req, res, 502, 'errors.aiInvalidResponse');
      }

      keywords = keywords
        .filter(function (k) { return typeof k === 'string' && k.trim(); })
        .map(function (k) { return k.trim().toLowerCase(); });

      const seen = {};
      keywords = keywords.filter(function (k) {
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });

      console.log('[Bedrock Keywords] Extracted:', keywords);
      res.json({ keywords });
    } catch (e) {
      console.error('[Bedrock Keywords] Error:', e.message);
      next(e);
    }
  });

  /* ── Semantic Scholar paper search ──────────────────────────────────── */

  router.get('/projects/:projectId/sources/search-scholar', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      const own = await query(
        getPool,
        'SELECT id FROM projects WHERE id = @id AND user_id = @user_id',
        { id: projectId, user_id: req.session.userId }
      );
      if (!own.recordset[0]) return apiErr(req, res, 404, 'errors.notFound');

      const rawQ = req.query.q || req.query.query || '';
      const keywords = rawQ
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
      if (!keywords.length) {
        return apiErr(req, res, 400, 'errors.queryQRequired');
      }

      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      console.log('[Semantic Scholar] Searching with keywords:', keywords.slice(0, 3), '..., limit:', limit);
      const results = await searchPapers(keywords, {
        limit,
        apiKey: process.env.S2_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || undefined,
        year: req.query.year || undefined,
        fieldsOfStudy: req.query.fieldsOfStudy || undefined,
      });
      console.log('[Semantic Scholar] Returned', results.length, 'papers');
      res.json({ papers: results });
    } catch (e) {
      console.error('[Semantic Scholar] Error:', e.message);
      if (e && e.message && e.message.includes('rate limit')) {
        const hasKey = !!(process.env.S2_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY);
        const msg = hasKey
          ? tReq(req, 'errors.semanticScholarRateLimit')
          : tReq(req, 'errors.semanticScholarNeedsApiKey');
        return res.status(429).json({ error: msg });
      }
      next(e);
    }
  });

  /* ── Crucible: all-sources (cross-project library) ────────────────── */

  router.get('/sources/all', async (req, res, next) => {
    try {
      const userId = req.session.userId;
      const rows = await query(
        getPool,
        `SELECT s.id, s.project_id, pr.name AS project_name,
                s.citation_text, s.notes, s.crucible_notes, s.doi,
                s.authors, s.publication_date, s.article_title, s.journal_title,
                s.volume_number, s.issue_number, s.page_numbers, s.chapter_name, s.conference_name,
                s.source_type, s.publisher, s.publisher_location, s.editors, s.book_title,
                s.url, s.edition, s.access_date, s.open_access_url, s.from_suggestion,
                s.sort_order, s.created_at, s.updated_at
         FROM sources s
         INNER JOIN projects pr ON pr.id = s.project_id
         WHERE pr.user_id = @user_id
         ORDER BY s.article_title, s.created_at`,
        { user_id: userId }
      );

      const sourceIds = rows.recordset.map(function (r) { return r.id; });
      let tagMap = {};
      let secMap = {};

      if (sourceIds.length) {
        const idList = sourceIds.join(',');
        const tagRows = await queryRaw(
          getPool,
          'SELECT source_id, tag FROM source_tags WHERE source_id IN (' + idList + ')'
        );
        tagRows.recordset.forEach(function (r) {
          if (!tagMap[r.source_id]) tagMap[r.source_id] = [];
          tagMap[r.source_id].push(r.tag);
        });
        const secRows = await queryRaw(
          getPool,
          'SELECT source_id, section_id FROM source_sections WHERE source_id IN (' + idList + ')'
        );
        secRows.recordset.forEach(function (r) {
          if (!secMap[r.source_id]) secMap[r.source_id] = [];
          secMap[r.source_id].push(r.section_id);
        });
      }

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

  /* ── Crucible: sources CRUD ─────────────────────────────────────────── */

  async function ownsProject(getPool, projectId, userId) {
    const r = await query(
      getPool,
      'SELECT id FROM projects WHERE id = @id AND user_id = @user_id',
      { id: projectId, user_id: userId }
    );
    return !!r.recordset[0];
  }

  router.get('/projects/:projectId/sources', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const rows = await query(
        getPool,
        `SELECT id, project_id, citation_text, notes, crucible_notes, doi,
                authors, publication_date, article_title, journal_title,
                volume_number, issue_number, page_numbers, chapter_name, conference_name,
                source_type, publisher, publisher_location, editors, book_title,
                url, edition, access_date, open_access_url, from_suggestion,
                sort_order, created_at, updated_at
         FROM sources WHERE project_id = @pid ORDER BY article_title, created_at`,
        { pid: projectId }
      );

      const tagRows = await query(
        getPool,
        `SELECT st.source_id, st.tag FROM source_tags st
         INNER JOIN sources s ON s.id = st.source_id
         WHERE s.project_id = @pid`,
        { pid: projectId }
      );
      const tagMap = {};
      tagRows.recordset.forEach(function (r) {
        if (!tagMap[r.source_id]) tagMap[r.source_id] = [];
        tagMap[r.source_id].push(r.tag);
      });

      const secRows = await query(
        getPool,
        `SELECT ss.source_id, ss.section_id FROM source_sections ss
         INNER JOIN sources s ON s.id = ss.source_id
         WHERE s.project_id = @pid`,
        { pid: projectId }
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
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

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
      const openAccessUrl    = trimOrNull(b.open_access_url);
      const fromSuggestion   = b.from_suggestion ? 1 : 0;
      const citationText     = (b.citation_text || '').trim() || '';
      const tags             = Array.isArray(b.tags) ? b.tags.map(function (t) { return String(t).trim(); }).filter(Boolean) : [];
      const sectionIds       = Array.isArray(b.section_ids) ? b.section_ids.map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !Number.isNaN(n); }) : [];

      if (!articleTitle && !citationText) {
        return apiErr(req, res, 400, 'errors.articleTitleOrCitationRequired');
      }

      const ins = await query(
        getPool,
        `INSERT INTO sources (project_id, citation_text, doi, authors, publication_date, article_title,
          journal_title, volume_number, issue_number, page_numbers, chapter_name, conference_name,
          source_type, publisher, publisher_location, editors, book_title, url, edition, access_date,
          open_access_url, from_suggestion)
         VALUES (@pid, @citation_text, @doi, @authors, @publication_date, @article_title,
          @journal_title, @volume_number, @issue_number, @page_numbers, @chapter_name, @conference_name,
          @source_type, @publisher, @publisher_location, @editors, @book_title, @url, @edition, @access_date,
          @open_access_url, @from_suggestion)`,
        {
          pid: projectId,
          citation_text: citationText,
          doi,
          authors,
          publication_date: publicationDate,
          article_title: articleTitle,
          journal_title: journalTitle,
          volume_number: volumeNumber,
          issue_number: issueNumber,
          page_numbers: pageNumbers,
          chapter_name: chapterName,
          conference_name: conferenceName,
          source_type: sourceType,
          publisher,
          publisher_location: publisherLocation,
          editors,
          book_title: bookTitle,
          url,
          edition,
          access_date: accessDate,
          open_access_url: openAccessUrl,
          from_suggestion: fromSuggestion,
        }
      );
      const sourceId = ins.insertId;

      for (const tag of tags) {
        await query(getPool, 'INSERT INTO source_tags (source_id, tag) VALUES (@source_id, @tag)', {
          source_id: sourceId,
          tag: tag.slice(0, 120),
        });
      }
      for (const secId of sectionIds) {
        const chk = await query(
          getPool,
          'SELECT 1 AS ok FROM project_sections WHERE id = @section_id AND project_id = @proj_id LIMIT 1',
          { section_id: secId, proj_id: projectId }
        );
        if (chk.recordset[0]) {
          await query(
            getPool,
            'INSERT INTO source_sections (source_id, section_id) VALUES (@source_id, @section_id)',
            { source_id: sourceId, section_id: secId }
          );
        }
      }

      const row = await query(
        getPool,
        `SELECT id, project_id, citation_text, notes, crucible_notes, doi,
                authors, publication_date, article_title, journal_title,
                volume_number, issue_number, page_numbers, chapter_name, conference_name,
                source_type, publisher, publisher_location, editors, book_title,
                url, edition, access_date, open_access_url, from_suggestion,
                sort_order, created_at, updated_at
         FROM sources WHERE id = @id`,
        { id: sourceId }
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
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const b = req.body || {};
      const updates = [];
      const patchParams = { sid: sourceId, pid: projectId };

      const textFields = [
        'authors',
        'publication_date',
        'article_title',
        'journal_title',
        'volume_number',
        'issue_number',
        'page_numbers',
        'doi',
        'chapter_name',
        'conference_name',
        'source_type',
        'publisher',
        'publisher_location',
        'editors',
        'book_title',
        'url',
        'edition',
        'access_date',
        'citation_text',
        'crucible_notes',
      ];
      textFields.forEach(function (key) {
        if (b[key] !== undefined) {
          const val = b[key] != null ? String(b[key]).trim() : null;
          updates.push(key + ' = @' + key);
          patchParams[key] = val || null;
        }
      });

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        const affected = await query(
          getPool,
          `UPDATE sources SET ${updates.join(', ')} WHERE id = @sid AND project_id = @pid`,
          patchParams
        );
        if (!affected.rowsAffected[0]) return apiErr(req, res, 404, 'errors.sourceNotFound');
      }

      if (Array.isArray(b.tags)) {
        await query(getPool, 'DELETE FROM source_tags WHERE source_id = @sid', { sid: sourceId });
        const tags = b.tags.map(function (t) { return String(t).trim(); }).filter(Boolean);
        for (const tag of tags) {
          await query(getPool, 'INSERT INTO source_tags (source_id, tag) VALUES (@source_id, @tag)', {
            source_id: sourceId,
            tag: tag.slice(0, 120),
          });
        }
      }

      if (Array.isArray(b.section_ids)) {
        await query(getPool, 'DELETE FROM source_sections WHERE source_id = @sid', { sid: sourceId });
        const sectionIds = b.section_ids.map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !Number.isNaN(n); });
        for (const secId of sectionIds) {
          const chk = await query(
            getPool,
            'SELECT 1 AS ok FROM project_sections WHERE id = @section_id AND project_id = @proj_id LIMIT 1',
            { section_id: secId, proj_id: projectId }
          );
          if (chk.recordset[0]) {
            await query(
              getPool,
              'INSERT INTO source_sections (source_id, section_id) VALUES (@source_id, @section_id)',
              { source_id: sourceId, section_id: secId }
            );
          }
        }
      }

      const row = await query(
        getPool,
        `SELECT id, project_id, citation_text, notes, crucible_notes, doi,
                authors, publication_date, article_title, journal_title,
                volume_number, issue_number, page_numbers, chapter_name, conference_name,
                source_type, publisher, publisher_location, editors, book_title,
                url, edition, access_date, open_access_url, from_suggestion,
                sort_order, created_at, updated_at
         FROM sources WHERE id = @id`,
        { id: sourceId }
      );
      if (!row.recordset[0]) return apiErr(req, res, 404, 'errors.sourceNotFound');

      const tRows = await query(getPool, 'SELECT tag FROM source_tags WHERE source_id = @sid', {
        sid: sourceId,
      });
      const sRows = await query(getPool, 'SELECT section_id FROM source_sections WHERE source_id = @sid', {
        sid: sourceId,
      });

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
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');
      const del = await query(
        getPool,
        'DELETE FROM sources WHERE id = @sid AND project_id = @pid',
        { sid: sourceId, pid: projectId }
      );
      if (!del.rowsAffected[0]) return apiErr(req, res, 404, 'errors.sourceNotFound');
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  /* ── Research Plan Items ──────────────────────────────────────────── */

  router.get('/projects/:projectId/research-plan', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const rows = await query(
        getPool,
        `SELECT id, project_id, suggestion_id, section_id, section_title,
                suggestion_body, passage_excerpt, keywords, research_needed,
                COALESCE(status, 'unresolved') AS status,
                created_at, updated_at
         FROM research_plan_items
         WHERE project_id = @pid
         ORDER BY created_at DESC`,
        { pid: projectId }
      );
      res.json({ items: rows.recordset });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/research-plan', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const b = req.body || {};
      function trimOrNull(v) { return (v || '').trim() || null; }
      const sectionId      = parseInt(b.section_id, 10) || 0;
      const sectionTitle    = trimOrNull(b.section_title);
      const suggestionBody  = trimOrNull(b.context) || trimOrNull(b.suggestion_body) || '';
      const keywords        = trimOrNull(b.keywords);
      const researchNeeded  = trimOrNull(b.research_needed);
      const status          = trimOrNull(b.status) || 'unresolved';

      const ins = await query(
        getPool,
        `INSERT INTO research_plan_items (project_id, section_id, section_title, suggestion_body, keywords, research_needed, status)
         VALUES (@pid, @section_id, @section_title, @suggestion_body, @keywords, @research_needed, @status)`,
        {
          pid: projectId,
          section_id: sectionId || 0,
          section_title: sectionTitle,
          suggestion_body: suggestionBody,
          keywords,
          research_needed: researchNeeded,
          status,
        }
      );

      const newId = ins.insertId;
      const row = await query(
        getPool,
        `SELECT id, project_id, suggestion_id, section_id, section_title,
                suggestion_body, passage_excerpt, keywords, research_needed,
                COALESCE(status, 'unresolved') AS status,
                created_at, updated_at
         FROM research_plan_items WHERE id = @id`,
        { id: newId }
      );
      res.status(201).json({ item: row.recordset[0] });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/projects/:projectId/research-plan/:itemId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const itemId = parseInt(req.params.itemId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(itemId))
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const newStatus = (req.body.status || '').trim();
      if (!['unresolved', 'resolved', 'dismissed'].includes(newStatus))
        return apiErr(req, res, 400, 'errors.crucibleStatusInvalid');

      const upd = await query(
        getPool,
        `UPDATE research_plan_items
         SET status = @status, updated_at = NOW()
         WHERE id = @id AND project_id = @pid`,
        { id: itemId, pid: projectId, status: newStatus }
      );
      if (!upd.rowsAffected[0]) return apiErr(req, res, 404, 'errors.itemNotFound');

      const row = await query(
        getPool,
        `SELECT id, project_id, suggestion_id, section_id, section_title,
                suggestion_body, passage_excerpt, keywords, research_needed,
                COALESCE(status, 'unresolved') AS status,
                created_at, updated_at
         FROM research_plan_items WHERE id = @id`,
        { id: itemId }
      );
      res.json({ item: row.recordset[0] });
    } catch (e) {
      next(e);
    }
  });

  /* ── Citation Usages ─────────────────────────────────────────────── */

  router.get('/projects/:projectId/citation-usages', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const rows = await query(
        getPool,
        `SELECT cu.id, cu.source_id, cu.section_id, cu.project_id, cu.cite_marker,
                cu.context_excerpt, cu.created_at, ps.title AS section_title
         FROM citation_usages cu
         LEFT JOIN project_sections ps ON ps.id = cu.section_id
         WHERE cu.project_id = @pid
         ORDER BY cu.created_at`,
        { pid: projectId }
      );
      res.json({ usages: rows.recordset });
    } catch (e) {
      next(e);
    }
  });

  router.get('/projects/:projectId/citation-usages/:sourceId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const sourceId = parseInt(req.params.sourceId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(sourceId))
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const rows = await query(
        getPool,
        `SELECT cu.id, cu.source_id, cu.section_id, cu.cite_marker,
                cu.context_excerpt, cu.created_at, ps.title AS section_title
         FROM citation_usages cu
         LEFT JOIN project_sections ps ON ps.id = cu.section_id
         WHERE cu.project_id = @pid AND cu.source_id = @sid
         ORDER BY cu.created_at`,
        { pid: projectId, sid: sourceId }
      );
      res.json({ usages: rows.recordset });
    } catch (e) {
      next(e);
    }
  });

  router.get('/citation-usages/source/:sourceId', async (req, res, next) => {
    try {
      const sourceId = parseInt(req.params.sourceId, 10);
      if (Number.isNaN(sourceId)) return apiErr(req, res, 400, 'errors.invalidId');
      const rows = await query(
        getPool,
        `SELECT cu.id, cu.source_id, cu.section_id, cu.project_id, cu.cite_marker,
                cu.context_excerpt, cu.created_at,
                ps.title AS section_title,
                pr.name  AS project_name
         FROM citation_usages cu
         LEFT JOIN project_sections ps ON ps.id = cu.section_id
         INNER JOIN projects pr ON pr.id = cu.project_id
         WHERE cu.source_id = @sid AND pr.user_id = @user_id
         ORDER BY pr.name, cu.created_at`,
        { sid: sourceId, user_id: req.session.userId }
      );
      res.json({ usages: rows.recordset });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects/:projectId/citation-usages', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      if (Number.isNaN(projectId)) return apiErr(req, res, 400, 'errors.invalidProjectId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      const b = req.body || {};
      const sourceId = parseInt(b.source_id, 10);
      const sectionId = parseInt(b.section_id, 10);
      if (Number.isNaN(sourceId) || Number.isNaN(sectionId))
        return apiErr(req, res, 400, 'errors.sourceSectionRequired');

      const citeMarker = (b.cite_marker || '').trim() || null;
      const contextExcerpt = (b.context_excerpt || '').trim() || null;

      const ins = await query(
        getPool,
        `INSERT INTO citation_usages (source_id, section_id, project_id, cite_marker, context_excerpt)
         VALUES (@source_id, @section_id, @pid, @cite_marker, @context_excerpt)`,
        {
          source_id: sourceId,
          section_id: sectionId,
          pid: projectId,
          cite_marker: citeMarker,
          context_excerpt: contextExcerpt,
        }
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/projects/:projectId/citation-usages/:usageId', async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.projectId, 10);
      const usageId = parseInt(req.params.usageId, 10);
      if (Number.isNaN(projectId) || Number.isNaN(usageId))
        return apiErr(req, res, 400, 'errors.invalidId');
      if (!(await ownsProject(getPool, projectId, req.session.userId)))
        return apiErr(req, res, 404, 'errors.notFound');

      await query(getPool, 'DELETE FROM citation_usages WHERE id = @id AND project_id = @pid', {
        id: usageId,
        pid: projectId,
      });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = createApiRouter;
