'use strict';

const { query, queryRaw } = require('./db');

/** Known app pages for admin UI and path → slug mapping. */
const TRAINING_PAGE_OPTIONS = [
  { slug: 'dashboard', label: 'Portfolio dashboard' },
  { slug: 'account', label: 'Account' },
  { slug: 'project-new', label: 'New project' },
  { slug: 'project-settings', label: 'Project settings' },
  { slug: 'anvil', label: 'The Anvil' },
  { slug: 'crucible', label: 'The Crucible' },
  { slug: 'foundry', label: 'The Foundry' },
  { slug: 'framework', label: 'Framework' },
  { slug: 'billing-subscribe', label: 'Subscribe / billing' },
  { slug: 'billing-payment-method', label: 'Payment method' },
];

/**
 * @param {string | undefined} raw
 * @returns {number} opacity 0–1 for white training panel (default 0.4 = 40% opacity)
 */
function parseTransTrainOpacity(raw) {
  if (raw == null || String(raw).trim() === '') return 0.4;
  const n = parseFloat(String(raw).trim(), 10);
  if (Number.isNaN(n)) return 0.4;
  if (n > 1) return Math.min(1, Math.max(0, n / 100));
  return Math.min(1, Math.max(0, n));
}

/**
 * Prefer pathname from originalUrl (full path behind reverse proxies); fall back to url then path.
 * @param {{ originalUrl?: string, url?: string, path?: string } | null | undefined} req
 * @returns {string}
 */
function pathFromRequest(req) {
  if (!req) return '';
  const fromOriginal = String(req.originalUrl || '').split('?')[0];
  if (fromOriginal) return fromOriginal.replace(/\/+/g, '/');
  const fromUrl = String(req.url || '').split('?')[0];
  if (fromUrl) return fromUrl.replace(/\/+/g, '/');
  return String(req.path || '').replace(/\/+/g, '/');
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function trainingPageSlugFromPath(path) {
  const p = String(path || '').split('?')[0].replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  if (p === '/app/dashboard') return 'dashboard';
  if (p === '/app/account' || p.startsWith('/app/account/')) return 'account';
  if (p === '/app/projects/new') return 'project-new';
  if (/^\/app\/project\/\d+\/settings/.test(p)) return 'project-settings';
  if (/^\/app\/project\/\d+\/anvil/.test(p)) return 'anvil';
  if (/^\/app\/project\/\d+\/crucible/.test(p)) return 'crucible';
  if (/^\/app\/project\/\d+\/foundry/.test(p)) return 'foundry';
  if (/^\/app\/project\/\d+\/framework/.test(p)) return 'framework';
  if (p === '/billing/subscribe' || p.startsWith('/billing/subscribe')) return 'billing-subscribe';
  if (p === '/billing/payment-method' || p.startsWith('/billing/payment-method'))
    return 'billing-payment-method';
  return null;
}

/**
 * @param {function} getPool
 * @param {string} pageSlug
 * @returns {Promise<object[]>}
 */
async function listEnabledStepsForPage(getPool, pageSlug) {
  const slug = String(pageSlug || '').trim().slice(0, 80);
  if (!slug) return [];
  const r = await query(
    getPool,
    `SELECT id, page_slug, focus_selector, body_text, sort_order, enabled
     FROM training_walkthrough_steps
     WHERE TRIM(page_slug) = @slug AND (enabled IS NULL OR enabled = 1)
     ORDER BY sort_order ASC, id ASC`,
    { slug }
  );
  return r.recordset || [];
}

/**
 * @param {function} getPool
 * @param {number} userId
 * @param {string} pageSlug
 */
async function userHasCompletedPage(getPool, userId, pageSlug) {
  const r = await query(
    getPool,
    `SELECT 1 AS ok FROM user_training_page_completions
     WHERE user_id = @uid AND page_slug = @slug LIMIT 1`,
    { uid: userId, slug: String(pageSlug).slice(0, 80) }
  );
  return !!(r.recordset && r.recordset[0]);
}

/**
 * @param {function} getPool
 * @param {number} userId
 * @param {string} pageSlug
 */
async function markPageCompleted(getPool, userId, pageSlug) {
  const slug = String(pageSlug || '').trim().slice(0, 80);
  if (!slug) return;
  await query(
    getPool,
    `INSERT INTO user_training_page_completions (user_id, page_slug, completed_at)
     VALUES (@uid, @slug, CURRENT_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE completed_at = CURRENT_TIMESTAMP(6)`,
    { uid: userId, slug }
  );
}

/**
 * @param {function} getPool
 * @param {number} userId
 * @param {string} pageSlug
 */
async function resetPageCompletion(getPool, userId, pageSlug) {
  const slug = String(pageSlug || '').trim().slice(0, 80);
  if (!slug) return;
  await query(getPool, `DELETE FROM user_training_page_completions WHERE user_id = @uid AND page_slug = @slug`, {
    uid: userId,
    slug,
  });
}

/**
 * @param {function} getPool
 * @param {number} userId
 * @param {string} reqPath
 * @param {number} transTrainOpacity
 * @returns {Promise<object | null>}
 */
async function loadTrainingClientPayload(getPool, userId, reqPath, transTrainOpacity) {
  const slug = trainingPageSlugFromPath(reqPath);
  if (!slug) return null;
  const steps = await listEnabledStepsForPage(getPool, slug);
  if (!steps.length) return null;
  const completed = await userHasCompletedPage(getPool, userId, slug);
  return {
    pageSlug: slug,
    steps: steps.map((row) => ({
      id: row.id,
      sortOrder: row.sort_order,
      focusSelector: row.focus_selector,
      text: row.body_text,
    })),
    completed,
    autoStart: !completed,
    transTrain: transTrainOpacity,
  };
}

/**
 * @param {function} getPool
 * @returns {Promise<object[]>}
 */
async function listAllStepsForAdmin(getPool) {
  const r = await query(
    getPool,
    `SELECT id, page_slug, focus_selector, body_text, sort_order, enabled, created_at, updated_at
     FROM training_walkthrough_steps
     ORDER BY page_slug ASC, sort_order ASC, id ASC`
  );
  return r.recordset || [];
}

/**
 * @param {function} getPool
 * @param {object} body
 */
async function adminUpsertStep(getPool, body) {
  const pageSlug = String(body.pageSlug || body.page_slug || '').trim().slice(0, 80);
  const focusSelector = String(body.focusSelector || body.focus_selector || '').trim().slice(0, 500);
  const text = String(body.text || body.body_text || '').trim();
  const sortOrder = parseInt(String(body.sortOrder ?? body.sort_order ?? '0'), 10);
  const enabled = body.enabled === false || body.enabled === 0 || body.enabled === '0' ? 0 : 1;
  if (!pageSlug) return { ok: false, error: 'pageSlug is required.' };
  if (!focusSelector) return { ok: false, error: 'focusSelector is required.' };
  if (!text) return { ok: false, error: 'text is required.' };

  const id = body.id != null ? parseInt(String(body.id), 10) : NaN;
  if (!Number.isNaN(id) && id > 0) {
    await query(
      getPool,
      `UPDATE training_walkthrough_steps
       SET page_slug = @page_slug, focus_selector = @focus_selector, body_text = @body_text,
           sort_order = @sort_order, enabled = @enabled, updated_at = CURRENT_TIMESTAMP(6)
       WHERE id = @id`,
      {
        id,
        page_slug: pageSlug,
        focus_selector: focusSelector,
        body_text: text.slice(0, 65000),
        sort_order: Number.isNaN(sortOrder) ? 0 : sortOrder,
        enabled,
      }
    );
    return { ok: true, id };
  }
  const ins = await query(
    getPool,
    `INSERT INTO training_walkthrough_steps (page_slug, focus_selector, body_text, sort_order, enabled)
     VALUES (@page_slug, @focus_selector, @body_text, @sort_order, @enabled)`,
    {
      page_slug: pageSlug,
      focus_selector: focusSelector,
      body_text: text.slice(0, 65000),
      sort_order: Number.isNaN(sortOrder) ? 0 : sortOrder,
      enabled,
    }
  );
  return { ok: true, id: ins.insertId };
}

/**
 * @param {function} getPool
 * @param {number} id
 */
async function adminDeleteStep(getPool, id) {
  if (!id || Number.isNaN(id)) return { ok: false, error: 'Invalid id.' };
  await query(getPool, `DELETE FROM training_walkthrough_steps WHERE id = @id`, { id });
  return { ok: true };
}

async function ensureTrainingWalkthroughSchema(getPool) {
  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS training_walkthrough_steps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      page_slug VARCHAR(80) NOT NULL,
      focus_selector VARCHAR(500) NOT NULL,
      body_text TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX ix_tws_page (page_slug, sort_order, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS user_training_page_completions (
      user_id INT NOT NULL,
      page_slug VARCHAR(80) NOT NULL,
      completed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (user_id, page_slug),
      CONSTRAINT fk_utpc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX ix_utpc_slug (page_slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

module.exports = {
  TRAINING_PAGE_OPTIONS,
  parseTransTrainOpacity,
  pathFromRequest,
  trainingPageSlugFromPath,
  listEnabledStepsForPage,
  userHasCompletedPage,
  markPageCompleted,
  resetPageCompletion,
  loadTrainingClientPayload,
  listAllStepsForAdmin,
  adminUpsertStep,
  adminDeleteStep,
  ensureTrainingWalkthroughSchema,
};
