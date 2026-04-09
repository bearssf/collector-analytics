require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { createPool, query, queryRaw } = require('./lib/db');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { ensureCoreSchema } = require('./lib/schema');
const {
  ensureSubscriptionRow,
  getSubscriptionRow,
  appAccessFromRow,
} = require('./lib/subscriptions');
const {
  listProjects,
  getProjectBundle,
  createProject,
  loadTemplates,
  saveProjectTemplates,
  initProjectTemplatesStore,
  templateOptionsForForm,
  updateProjectSettings,
  PURPOSES,
  CITATION_STYLES,
} = require('./lib/projectService');
const {
  normalizeTitleToKey,
  normalizeSearchEngineToKey,
  isAllowedTitleKey,
  isAllowedSearchEngineKey,
  SEARCH_ENGINE_KEYS_ORDERED,
  TITLE_KEYS_ORDERED,
} = require('./lib/canonicalSelects');
const { getUserProfileRow, rowToPublicUser } = require('./lib/userProfile');
const createApiRouter = require('./routes/api');
const createBillingApiRouter = require('./routes/billingApi');
const { handleStripeWebhook } = require('./lib/billingStripe');
const {
  getStripePriceConfig,
  getStripePublishableKey,
  isStripeBillingConfigured,
  isStripeElementsBillingConfigured,
  billingPriceEnvHint,
} = require('./lib/billingConfig');
const {
  buildBillingSummaryLines,
  resolvePlanInterval,
  isWithinDaysBeforePeriodEnd,
  formatLongDate,
} = require('./lib/billingAccountDisplay');
const { buildDashboardProjectProgress, dashboardCategory } = require('./lib/dashboardProgress');
const {
  parseTransTrainOpacity,
  pathFromRequest,
  trainingPageSlugFromPath,
  loadTrainingClientPayload,
  listAllStepsForAdmin,
  adminUpsertStep,
  adminDeleteStep,
  reorderTrainingStep,
  TRAINING_PAGE_OPTIONS,
  trainingAnchorsForAdmin,
  ensureTrainingWalkthroughSchema,
} = require('./lib/trainingWalkthrough');
const { getResearchAnatomyAdminStats } = require('./lib/researchAnatomyStats');
const { isBedrockConfigured } = require('./lib/bedrockReview');
const { runStage1Decomposition } = require('./lib/researchStage1Decomposition');
const {
  recordStage1BedrockRun,
  listStage1BedrockRuns,
  saveStage1FinalPlan,
  getLatestStage1FinalPlan,
} = require('./lib/researchStage1Storage');
const { saveStage2Corpus, getLatestStage2Corpus } = require('./lib/researchStage2Storage');
const { MIN_REVIEW_WORDS } = require('./lib/researchAnatomyService');
const { fetchBillingHistoryForCustomer } = require('./lib/billingHistory');
const { applyPaymentMethodFromSetupIntent } = require('./lib/billingPaymentMethod');
const { ensureStripeCustomer, getExistingValidStripeCustomerId } = require('./lib/billingElements');
const {
  ensurePasswordResetSchema,
  createPasswordResetToken,
  findUserIdByEmail,
  findValidTokenRow,
  resetPasswordWithToken,
} = require('./lib/passwordReset');
const { isMailConfigured, sendPasswordResetEmail, sendRegistrationVerificationEmail } = require('./lib/mail');
const {
  isNewUserVerificationEnabled,
  maskEmail,
  createPendingRegistration,
  verifyCodeAndCompleteUser,
  resendVerificationCode,
  changePendingEmail,
  loadPendingForVerifyPage,
  getPendingById,
  RESEND_COOLDOWN_MS,
} = require('./lib/registrationVerification');
const i18n = require('./lib/i18n');

const app = express();

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}
const PORT = process.env.PORT || 3000;

/** The Anvil — idle delay before first Bedrock review; character threshold for follow-ups (see docs/anvil-workspace.md). ANVIL2_* still supported. */
const ANVIL_INITIAL_IDLE_MS = Math.max(
  0,
  parseInt(
    process.env.ANVIL_INITIAL_IDLE_MS || process.env.ANVIL2_INITIAL_IDLE_MS || '1800',
    10
  ) || 1800
);
const ANVIL_INCREMENTAL_CHARS = Math.max(
  1,
  parseInt(
    process.env.ANVIL_INCREMENTAL_CHARS || process.env.ANVIL2_INCREMENTAL_CHARS || '40',
    10
  ) || 40
);
const AUTOSAVE_CHAR_THRESHOLD = Math.max(
  1,
  parseInt(process.env.AUTOSAVE_CHAR_THRESHOLD || '250', 10) || 250
);
const SCORE_STRONG_THRESHOLD = parseFloat(process.env.SCORE_STRONG_THRESHOLD || '0.05') || 0.05;
const SCORE_MODERATE_THRESHOLD = parseFloat(process.env.SCORE_MODERATE_THRESHOLD || '0.15') || 0.15;

/** MySQL TLS for Cloud SQL and other hosts that require SSL (mysql2 pool). */
function buildMysqlSslFromEnv() {
  const flag = String(process.env.DB_SSL || '').trim().toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
  if (!enabled) return undefined;

  const caPath = process.env.DB_SSL_CA_PATH;
  if (caPath && String(caPath).trim()) {
    const resolved = path.isAbsolute(caPath) ? caPath : path.join(process.cwd(), String(caPath).trim());
    const ca = fs.readFileSync(resolved, 'utf8');
    return { ca, rejectUnauthorized: true };
  }
  const caPem = process.env.DB_SSL_CA_PEM;
  if (caPem && String(caPem).trim()) {
    const ca = String(caPem).replace(/\\n/g, '\n');
    return { ca, rejectUnauthorized: true };
  }
  const strict = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || '')
    .trim()
    .toLowerCase();
  const rejectUnauthorized = strict === '1' || strict === 'true' || strict === 'yes';
  return { rejectUnauthorized };
}

const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: 10,
  ssl: buildMysqlSslFromEnv(),
};

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    if (!stripe) return res.status(503).send('Stripe not configured');
    return handleStripeWebhook(req, res, stripe, getPool);
  })
);

app.use(express.json({ limit: '2mb' }));

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-change-session-secret';

/** Set when REDIS_URL is present; connected in start() before listen(). */
let redisSessionClient = null;

function createSessionMiddleware() {
  const opts = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  };
  if (process.env.REDIS_URL) {
    const { createClient } = require('redis');
    const RedisStore = require('connect-redis').default;
    redisSessionClient = createClient({ url: process.env.REDIS_URL });
    redisSessionClient.on('error', (err) => console.error('Redis session store:', err.message));
    opts.store = new RedisStore({ client: redisSessionClient });
  }
  return session(opts);
}

app.use(createSessionMiddleware());
app.use(i18n.attachLocaleMiddleware());

/** Strip surrounding quotes (common on Render / .env paste) and whitespace. */
function trimAdminTemplateToken(v) {
  if (v == null || v === '') return '';
  let s = String(v).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Minimum length for ADMIN_TEMPLATE_EDITOR_TOKEN (after trim). Shorter values were rejected before URL token was compared — use 8+ and match Render exactly. */
const ADMIN_TEMPLATE_TOKEN_MIN_LEN = 8;

/**
 * Token for Research Anatomy stats admin URL.
 * Precedence: dedicated → training walkthrough → project templates, so an existing admin token unlocks stats.
 */
function researchAnatomyStatsAdminToken() {
  const dedicated = trimAdminTemplateToken(process.env.ADMIN_RESEARCH_ANATOMY_STATS_TOKEN);
  if (dedicated.length >= ADMIN_TEMPLATE_TOKEN_MIN_LEN) return dedicated;
  const train = trimAdminTemplateToken(process.env.ADMIN_TRAINING_EDITOR_TOKEN);
  if (train.length >= ADMIN_TEMPLATE_TOKEN_MIN_LEN) return train;
  return trimAdminTemplateToken(process.env.ADMIN_TEMPLATE_EDITOR_TOKEN);
}

/** App sidebar: show links to token-gated admin tools only for this signed-in user (URLs include secrets from env). */
const ADMIN_SIDEBAR_NAV_EMAIL = 'bearssf@tiffin.edu';

function applyAdminSidebarNavLocals(req, res) {
  res.locals.showAdminNav = false;
  res.locals.adminProjectTemplatesHref = '';
  res.locals.adminTrainingHref = '';
  res.locals.adminResearchAnatomyHref = '';
  res.locals.adminResearchStage1Href = '';
  if (!req.session || !req.session.user || !req.session.user.email) return;
  if (String(req.session.user.email).toLowerCase() !== ADMIN_SIDEBAR_NAV_EMAIL.toLowerCase()) {
    return;
  }
  res.locals.adminResearchStage1Href = '/admin/research-stage1';
  res.locals.adminResearchStage1TimingHref = '/admin/research-stage1-timing';
  res.locals.adminResearchStage2Href = '/admin/research-stage2';
  res.locals.adminResearchStage2EnrichmentHref = '/admin/research-stage2-enrichment';
  const tplTok = trimAdminTemplateToken(process.env.ADMIN_TEMPLATE_EDITOR_TOKEN);
  const trainTok = trimAdminTemplateToken(process.env.ADMIN_TRAINING_EDITOR_TOKEN);
  const raTok = researchAnatomyStatsAdminToken();
  if (tplTok.length >= ADMIN_TEMPLATE_TOKEN_MIN_LEN) {
    res.locals.adminProjectTemplatesHref =
      '/admin/project-templates?token=' + encodeURIComponent(tplTok);
  }
  if (trainTok.length >= ADMIN_TEMPLATE_TOKEN_MIN_LEN) {
    res.locals.adminTrainingHref =
      '/admin/training-walkthrough?token=' + encodeURIComponent(trainTok);
  }
  if (raTok.length >= ADMIN_TEMPLATE_TOKEN_MIN_LEN) {
    res.locals.adminResearchAnatomyHref =
      '/admin/research-anatomy-stats?token=' + encodeURIComponent(raTok);
  }
  res.locals.showAdminNav = !!(
    res.locals.adminProjectTemplatesHref ||
    res.locals.adminTrainingHref ||
    res.locals.adminResearchAnatomyHref ||
    res.locals.adminResearchStage1Href ||
    res.locals.adminResearchStage1TimingHref ||
    res.locals.adminResearchStage2Href ||
    res.locals.adminResearchStage2EnrichmentHref
  );
}

function adminTemplateTokenFromReq(req) {
  const q = req.query && req.query.token;
  if (q != null) {
    const raw = Array.isArray(q) ? q[0] : q;
    if (String(raw).trim() !== '') return String(raw);
  }
  if (req.params && req.params.token != null) return String(req.params.token);
  return '';
}

function sendAdminGateNotFound(res) {
  res
    .status(404)
    .type('html')
    .send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Not found</title>' +
        '<style>body{margin:0;font-family:system-ui,sans-serif;background:#eceff1;color:#263238;padding:1.5rem;line-height:1.5}' +
        'code{font-size:.9em;background:#cfd8dc;padding:.1rem .25rem;border-radius:4px}</style></head><body>' +
        '<p><strong>Not found</strong></p>' +
        '<p style="font-size:.9rem;max-width:36rem">If you are opening the project-templates admin URL, set ' +
        '<code>ADMIN_TEMPLATE_EDITOR_TOKEN</code> on the server (at least ' +
        ADMIN_TEMPLATE_TOKEN_MIN_LEN +
        ' characters), redeploy, and use the exact value in the path or as ' +
        '<code>?token=…</code>. The value in Render must match the URL character-for-character.</p>' +
        '</body></html>'
    );
}

function requireAdminTemplateEditorToken(req, res, next) {
  const secret = trimAdminTemplateToken(process.env.ADMIN_TEMPLATE_EDITOR_TOKEN);
  if (!secret || secret.length < ADMIN_TEMPLATE_TOKEN_MIN_LEN) {
    return sendAdminGateNotFound(res);
  }
  const token = trimAdminTemplateToken(adminTemplateTokenFromReq(req));
  if (token !== secret) {
    return sendAdminGateNotFound(res);
  }
  next();
}

function renderAdminProjectTemplatesPage(req, res) {
  const data = JSON.stringify(loadTemplates());
  const safe = data.replace(/</g, '\\u003c');
  res.render('admin-project-templates', { templatesData: safe });
}

async function postAdminProjectTemplatesSave(req, res, next) {
  try {
    const tpl = req.body && req.body.templates;
    if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) {
      return res.status(400).json({ ok: false, error: 'Missing templates object.' });
    }
    const result = await saveProjectTemplates(getPool, tpl);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

/* Prefer ?token=... — path /:token breaks if the secret contains "/" (only one segment is captured). */
app.get('/admin/project-templates', requireAdminTemplateEditorToken, renderAdminProjectTemplatesPage);
app.post('/admin/project-templates', requireAdminTemplateEditorToken, postAdminProjectTemplatesSave);

app.get('/admin/project-templates/:token', requireAdminTemplateEditorToken, renderAdminProjectTemplatesPage);
app.post('/admin/project-templates/:token', requireAdminTemplateEditorToken, postAdminProjectTemplatesSave);

function requireAdminTrainingEditorToken(req, res, next) {
  const secret = trimAdminTemplateToken(process.env.ADMIN_TRAINING_EDITOR_TOKEN);
  if (!secret || secret.length < ADMIN_TEMPLATE_TOKEN_MIN_LEN) {
    return sendAdminGateNotFound(res);
  }
  const token = trimAdminTemplateToken(adminTemplateTokenFromReq(req));
  if (token !== secret) {
    return sendAdminGateNotFound(res);
  }
  next();
}

async function renderAdminTrainingWalkthroughPage(req, res, next) {
  try {
    const rows = await listAllStepsForAdmin(getPool);
    const payload = {
      pages: TRAINING_PAGE_OPTIONS,
      pageAnchors: trainingAnchorsForAdmin(),
      steps: rows,
    };
    const data = JSON.stringify(payload);
    const safe = data.replace(/</g, '\\u003c');
    res.render('admin-training-walkthrough', { trainingAdminJson: safe });
  } catch (e) {
    next(e);
  }
}

async function postAdminTrainingUpsert(req, res) {
  const result = await adminUpsertStep(getPool, req.body || {});
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}

async function postAdminTrainingDelete(req, res) {
  const id = parseInt(String((req.body && req.body.id) || ''), 10);
  const result = await adminDeleteStep(getPool, id);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
}

async function postAdminTrainingReorder(req, res) {
  const stepId = parseInt(String((req.body && req.body.stepId) || ''), 10);
  const direction = (req.body && req.body.direction) || '';
  const result = await reorderTrainingStep(getPool, stepId, direction);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
}

app.get(
  '/admin/training-walkthrough',
  requireAdminTrainingEditorToken,
  asyncHandler(renderAdminTrainingWalkthroughPage)
);
app.post('/admin/training-walkthrough/step', requireAdminTrainingEditorToken, asyncHandler(postAdminTrainingUpsert));
app.post('/admin/training-walkthrough/delete', requireAdminTrainingEditorToken, asyncHandler(postAdminTrainingDelete));
app.post('/admin/training-walkthrough/reorder', requireAdminTrainingEditorToken, asyncHandler(postAdminTrainingReorder));

function requireAdminResearchAnatomyStatsToken(req, res, next) {
  const secret = researchAnatomyStatsAdminToken();
  if (!secret || secret.length < ADMIN_TEMPLATE_TOKEN_MIN_LEN) {
    return sendAdminGateNotFound(res);
  }
  const token = trimAdminTemplateToken(adminTemplateTokenFromReq(req));
  if (token !== secret) {
    return sendAdminGateNotFound(res);
  }
  next();
}

async function renderAdminResearchAnatomyStats(req, res, next) {
  try {
    const stats = await getResearchAnatomyAdminStats(getPool);
    res.render('admin-research-anatomy-stats', { stats });
  } catch (e) {
    next(e);
  }
}

app.get(
  '/admin/research-anatomy-stats',
  requireAdminResearchAnatomyStatsToken,
  asyncHandler(renderAdminResearchAnatomyStats)
);

function requireBearssfAdminSession(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Sign in required.' });
  }
  if (
    !req.session.user ||
    String(req.session.user.email).toLowerCase() !== ADMIN_SIDEBAR_NAV_EMAIL.toLowerCase()
  ) {
    return res.status(403).json({ ok: false, error: 'Forbidden.' });
  }
  next();
}

function requireBearssfAdminPage(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect(`/?signin=1&next=${encodeURIComponent(req.originalUrl)}`);
  }
  if (
    !req.session.user ||
    String(req.session.user.email).toLowerCase() !== ADMIN_SIDEBAR_NAV_EMAIL.toLowerCase()
  ) {
    return res
      .status(403)
      .type('html')
      .send(
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Forbidden</title></head><body><p>Forbidden.</p></body></html>'
      );
  }
  next();
}

async function renderAdminResearchStage1(req, res) {
  res.render('admin-research-stage1', {});
}

async function postAdminResearchStage1Decompose(req, res) {
  try {
    if (!isBedrockConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'Bedrock is not configured (AWS_REGION and model / inference profile env vars).',
      });
    }
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const keywordsRaw = body.keywords;
    let keywords = [];
    if (Array.isArray(keywordsRaw)) {
      keywords = keywordsRaw.map((k) => String(k).trim()).filter(Boolean);
    } else if (keywordsRaw != null && String(keywordsRaw).trim()) {
      keywords = String(keywordsRaw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const projectType = String(body.projectType || body.project_type || 'dissertation').trim();
    const description =
      body.description != null && String(body.description).trim()
        ? String(body.description).trim()
        : null;

    const t0 = Date.now();
    const plan = await runStage1Decomposition({
      title,
      keywords,
      projectType,
      description,
    });
    const durationMs = Date.now() - t0;
    try {
      await recordStage1BedrockRun(getPool, req.session.userId, durationMs);
    } catch (logErr) {
      console.error('[research-stage1] Could not log Bedrock run timing:', logErr.message || logErr);
    }
    res.json({ ok: true, plan, durationMs });
  } catch (e) {
    if (e && e.code === 'VALIDATION') {
      return res.status(400).json({ ok: false, error: e.message || 'Invalid input.' });
    }
    res.status(500).json({ ok: false, error: e.message || 'Decomposition failed.' });
  }
}

async function renderAdminResearchStage1Timing(req, res) {
  const runs = await listStage1BedrockRuns(getPool, req.session.userId, 500);
  res.render('admin-research-stage1-timing', { runs });
}

async function postAdminResearchStage1Finalize(req, res) {
  try {
    const plan = req.body && req.body.plan;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      return res.status(400).json({ ok: false, error: 'Missing plan object.' });
    }
    const cleaned = JSON.parse(JSON.stringify(plan));
    delete cleaned.construct_overlap_flags;
    const pt = req.body && req.body.project_type;
    if (pt != null && String(pt).trim()) {
      cleaned.project_type = String(pt).trim();
    }
    await saveStage1FinalPlan(getPool, req.session.userId, cleaned);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Save failed.' });
  }
}

const STAGE2_CORPUS_TYPES = ['assignment', 'dissertation', 'conference', 'journal'];

async function renderAdminResearchStage2(req, res) {
  res.render('admin-research-stage2', {});
}

async function renderAdminResearchStage2Enrichment(req, res) {
  res.render('admin-research-stage2-enrichment', {});
}

async function getApiAdminResearchStage1LatestPlan(req, res) {
  try {
    const row = await getLatestStage1FinalPlan(getPool, req.session.userId);
    if (!row) {
      return res.status(404).json({
        ok: false,
        error: 'No saved Stage 1 plan. Finalize a plan on Stage 1 first.',
      });
    }
    let plan;
    try {
      plan = JSON.parse(String(row.plan_json));
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Stored plan is invalid JSON.' });
    }
    res.json({ ok: true, plan });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Failed to load plan.' });
  }
}

async function getApiAdminResearchStage2Latest(req, res) {
  try {
    const data = await getLatestStage2Corpus(getPool, req.session.userId);
    if (!data) {
      return res.json({ ok: true, hasData: false });
    }
    res.json({
      ok: true,
      hasData: true,
      corpus: data.corpus,
      statistics: data.statistics,
      project_type: data.project_type,
      created_at: data.created_at,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Failed to load corpus.' });
  }
}

function postAdminResearchStage2Run(req, res) {
  const projectTypeRaw = String((req.body && req.body.projectType) || 'dissertation').trim();
  const projectType = STAGE2_CORPUS_TYPES.includes(projectTypeRaw)
    ? projectTypeRaw
    : 'dissertation';
  const mailto =
    (req.session.user && req.session.user.email) ||
    process.env.OPENALEX_MAILTO ||
    'bearssf@tiffin.edu';

  if (typeof req.setTimeout === 'function') {
    req.setTimeout(0);
  }
  if (typeof res.setTimeout === 'function') {
    res.setTimeout(0);
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  let stopKeepAlive = () => {};
  let sseClosed = false;
  function closeSse() {
    if (sseClosed) return;
    sseClosed = true;
    stopKeepAlive();
    try {
      res.end();
    } catch (_) {
      /* ignore */
    }
  }

  function startSseKeepAlive() {
    const raw = parseInt(process.env.STAGE2_SSE_KEEPALIVE_MS || '15000', 10);
    const ms = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? raw : 15000, 5000), 120000);
    const tid = setInterval(() => {
      try {
        if (sseClosed) return;
        res.write(': keepalive\n\n');
      } catch (_) {
        stopKeepAlive();
      }
    }, ms);
    stopKeepAlive = () => {
      clearInterval(tid);
      stopKeepAlive = () => {};
    };
  }

  (async () => {
    let plan = req.body && req.body.plan;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      try {
        const row = await getLatestStage1FinalPlan(getPool, req.session.userId);
        if (!row) {
          res.write(
            `data: ${JSON.stringify({
              event: 'error',
              message: 'No saved Stage 1 plan. Complete Stage 1 and save the final plan first.',
            })}\n\n`
          );
          closeSse();
          return;
        }
        plan = JSON.parse(String(row.plan_json));
      } catch (e) {
        res.write(
          `data: ${JSON.stringify({
            event: 'error',
            message: e.message || 'Could not load Stage 1 plan.',
          })}\n\n`
        );
        closeSse();
        return;
      }
    }

    const effectiveType =
      (plan && plan.project_type && STAGE2_CORPUS_TYPES.includes(String(plan.project_type).trim())
        ? String(plan.project_type).trim()
        : null) || projectType;

    const payloadObj = {
      decomposition: plan,
      project_type: effectiveType,
      mailto: String(mailto),
    };
    const scriptPath = path.join(__dirname, 'stage2_retrieval.py');
    startSseKeepAlive();
    const child = spawn(process.env.PYTHON || 'python3', [scriptPath], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk) => {
      if (sseClosed) return;
      stderrBuf += chunk.toString();
      const parts = stderrBuf.split(/\r?\n/);
      stderrBuf = parts.pop() || '';
      for (const line of parts) {
        if (line.startsWith('STAGE2_PROG ')) {
          const jsonStr = line.slice(12).trim();
          try {
            const ev = JSON.parse(jsonStr);
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          } catch (_) {
            /* ignore */
          }
        } else if (line.trim()) {
          // Python logging (OpenAlex / Semantic Scholar detail) — appears in host logs (Render, etc.)
          console.error('[research-stage2:py]', line.length > 2500 ? `${line.slice(0, 2500)}…` : line);
        }
      }
    });

    let stdoutBuf = '';
    child.stdout.on('data', (c) => {
      stdoutBuf += c.toString();
    });

    child.on('error', (err) => {
      try {
        if (!sseClosed) {
          res.write(
            `data: ${JSON.stringify({ event: 'error', message: err.message || 'spawn failed' })}\n\n`
          );
        }
      } catch (_) {
        /* ignore */
      }
      closeSse();
    });

    child.on('close', async (code) => {
      if (sseClosed) return;
      try {
        if (code !== 0 && !stdoutBuf.trim()) {
          res.write(
            `data: ${JSON.stringify({
              event: 'error',
              message: `Python exited with code ${code}`,
            })}\n\n`
          );
          closeSse();
          return;
        }
        const result = JSON.parse(stdoutBuf);
        try {
          await saveStage2Corpus(
            getPool,
            req.session.userId,
            effectiveType,
            result.corpus || [],
            result.statistics || {}
          );
        } catch (saveErr) {
          console.error('[research-stage2] Save failed:', saveErr.message || saveErr);
        }
        res.write(`data: ${JSON.stringify({ event: 'done', result })}\n\n`);
      } catch (e) {
        res.write(
          `data: ${JSON.stringify({
            event: 'error',
            message: e.message || 'Invalid Python output',
            stdoutPreview: stdoutBuf.slice(0, 500),
          })}\n\n`
        );
      }
      closeSse();
    });

    try {
      child.stdin.write(JSON.stringify(payloadObj));
      child.stdin.end();
    } catch (e) {
      try {
        res.write(`data: ${JSON.stringify({ event: 'error', message: e.message || 'stdin' })}\n\n`);
      } catch (_) {
        /* ignore */
      }
      closeSse();
    }
  })().catch((e) => {
    try {
      res.write(`data: ${JSON.stringify({ event: 'error', message: e.message || 'failed' })}\n\n`);
    } catch (_) {
      /* ignore */
    }
    closeSse();
  });
}

app.get('/admin/research-stage1', requireBearssfAdminPage, asyncHandler(renderAdminResearchStage1));
app.get('/admin/research-stage1-timing', requireBearssfAdminPage, asyncHandler(renderAdminResearchStage1Timing));
app.get('/admin/research-stage2', requireBearssfAdminPage, asyncHandler(renderAdminResearchStage2));
app.get(
  '/admin/research-stage2-enrichment',
  requireBearssfAdminPage,
  asyncHandler(renderAdminResearchStage2Enrichment)
);
app.post(
  '/api/admin/research-stage1-decompose',
  requireBearssfAdminSession,
  asyncHandler(postAdminResearchStage1Decompose)
);
app.post(
  '/api/admin/research-stage1-finalize',
  requireBearssfAdminSession,
  asyncHandler(postAdminResearchStage1Finalize)
);
app.get(
  '/api/admin/research-stage1-latest-plan',
  requireBearssfAdminSession,
  asyncHandler(getApiAdminResearchStage1LatestPlan)
);
app.get(
  '/api/admin/research-stage2-latest',
  requireBearssfAdminSession,
  asyncHandler(getApiAdminResearchStage2Latest)
);
app.post('/api/admin/research-stage2-run', requireBearssfAdminSession, postAdminResearchStage2Run);

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect(`/?signin=1&next=${encodeURIComponent(req.originalUrl)}`);
}

/** Foundry: paid members only — not included in trial. Backed by `subscriptions` row. */
async function loadAppAccess(req, res, next) {
  try {
    if (process.env.DEV_SUBSCRIPTION_PAID === 'true') {
      res.locals.appAccess = {
        paid: true,
        trialing: false,
        trialEndsAt: null,
        trialEndsLabel: '',
        foundryUnlocked: true,
      };
      return next();
    }
    if (!req.session.userId) {
      res.locals.appAccess = null;
      return next();
    }
    await ensureSubscriptionRow(getPool, req.session.userId);
    const row = await getSubscriptionRow(getPool, req.session.userId);
    res.locals.appAccess = appAccessFromRow(row);
    next();
  } catch (e) {
    next(e);
  }
}

let pool = null;

async function getPool() {
  if (pool) return pool;
  pool = createPool(dbConfig);
  return pool;
}

app.use('/api', createApiRouter(getPool));
app.use('/api/billing', createBillingApiRouter(getPool, stripe));

function trainingRenderLocals(res) {
  return {
    trainingClientPayload: res.locals.trainingClientPayload,
    trainingReplayAvailable: res.locals.trainingReplayAvailable,
    trainingPageSlug: res.locals.trainingPageSlug,
    transTrainOpacity: res.locals.transTrainOpacity,
  };
}

async function attachTrainingWalkthroughLocals(req, res, next) {
  res.locals.trainingClientPayload = null;
  res.locals.trainingReplayAvailable = false;
  res.locals.trainingPageSlug = null;
  res.locals.transTrainOpacity = parseTransTrainOpacity(process.env.TRANS_TRAIN);
  applyAdminSidebarNavLocals(req, res);
  if (!req.session || !req.session.userId) return next();
  res.locals.trainingPageSlug = trainingPageSlugFromPath(pathFromRequest(req)) || null;
  try {
    const payload = await loadTrainingClientPayload(
      getPool,
      req.session.userId,
      pathFromRequest(req),
      res.locals.transTrainOpacity,
      req.locale
    );
    if (payload) {
      res.locals.trainingClientPayload = payload;
      res.locals.trainingReplayAvailable = true;
    }
  } catch (e) {
    console.error('Training walkthrough locals:', e.message);
  }
  next();
}

app.use('/app', asyncHandler(attachTrainingWalkthroughLocals));
app.use('/billing', asyncHandler(attachTrainingWalkthroughLocals));

async function ensureUsersTable() {
  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(20) NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      university VARCHAR(255) NULL,
      research_focus LONGTEXT NULL,
      preferred_search_engine VARCHAR(100) NULL,
      created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

async function ensureUserExtraColumns() {
  const cols = [
    { name: 'title', def: 'VARCHAR(20) NULL' },
    { name: 'university', def: 'VARCHAR(255) NULL' },
    { name: 'research_focus', def: 'LONGTEXT NULL' },
    { name: 'preferred_search_engine', def: 'VARCHAR(100) NULL' },
    { name: 'preferred_locale', def: "VARCHAR(12) NOT NULL DEFAULT 'en'" },
  ];
  for (const { name, def } of cols) {
    try {
      await queryRaw(getPool, 'ALTER TABLE users ADD COLUMN `' + name + '` ' + def);
    } catch (e) {
      const dup =
        e.errno === 1060 ||
        e.code === 'ER_DUP_FIELDNAME' ||
        e.code === 'ER_DUP_FIELD_NAME';
      if (!dup) throw e;
    }
  }
}

function loadUniversities() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'us-universities.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function safeReturnTo(val) {
  const s = String(val || '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  return s.split('?')[0] || '/';
}

/** When getProjectBundle returns null: 404 if missing, redirect if project was canceled. */
async function respondIfProjectUnavailable(req, res, projectId) {
  const r = await query(
    getPool,
    `SELECT status FROM projects WHERE id = @id AND user_id = @user_id`,
    { id: projectId, user_id: req.session.userId }
  );
  const rec = r.recordset[0];
  if (!rec) {
    res.status(404).send('Not found');
    return true;
  }
  if (String(rec.status || '').toLowerCase() === 'canceled') {
    res.redirect(302, '/app/dashboard');
    return true;
  }
  res.status(404).send('Not found');
  return true;
}

/** Set UI language cookie; updates DB when signed in. */
app.get('/locale/set', asyncHandler(async (req, res) => {
  const code = i18n.normalizeLocale(req.query.code || req.query.lang || 'en');
  const ret = safeReturnTo(req.query.returnTo || '/');
  i18n.setLocaleCookie(res, code);
  if (req.session) {
    req.session.locale = code;
  }
  if (req.session && req.session.userId) {
    try {
      await query(getPool, 'UPDATE users SET preferred_locale = @l WHERE id = @id', {
        l: code,
        id: req.session.userId,
      });
    } catch (e) {
      console.error('locale/set:', e.message);
    }
  }
  res.redirect(302, ret);
}));

function publicAppOrigin() {
  const b = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (!b) return '';
  return b.replace(/\/$/, '');
}

app.get('/', (req, res) => {
  const next = req.query.next ? safeReturnTo(req.query.next) : '/';
  res.render('home', {
    user: req.session.user || null,
    error: req.query.error || null,
    returnTo: next,
    openSignin: req.query.signin === '1',
    resetSuccess: req.query.reset === 'success',
  });
});

app.get('/product', (req, res) => {
  const next = req.query.next ? safeReturnTo(req.query.next) : '/product';
  res.render('product', {
    user: req.session.user || null,
    error: req.query.error || null,
    navActive: 'product',
    returnTo: next,
    openSignin: req.query.signin === '1',
    resetSuccess: req.query.reset === 'success',
  });
});

const WORKSPACE_PHASES = {
  anvil: {
    title: 'The Anvil',
    insight: 'Anchor-based AI writing feedback for your section drafts.',
  },
  crucible: {
    title: 'The Crucible',
    insight: 'Source management and research tools will appear here.',
  },
  foundry: { title: 'The Foundry', insight: 'Generated research topics and gaps will appear here for paid members.' },
  framework: { title: 'Research Anatomy', insight: 'Forged review and assessment for research anatomy will appear here.' },
};

/** i18n keys for workspace rail (see locales/en.json sidebar + workspace). */
const WORKSPACE_PHASE_TITLE_KEYS = {
  anvil: 'sidebar.anvil',
  crucible: 'sidebar.crucible',
  foundry: 'sidebar.foundry',
  framework: 'sidebar.framework',
};
const WORKSPACE_PHASE_INSIGHT_KEYS = {
  anvil: 'workspace.insightAnvil',
  crucible: 'workspace.insightCrucible',
  foundry: 'workspace.insightFoundry',
  framework: 'workspace.insightFramework',
};

app.get('/app', requireAuth, asyncHandler(loadAppAccess), (req, res) => {
  res.redirect('/app/dashboard');
});

app.get(
  '/app/dashboard',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = null;
    const projectProgress = await buildDashboardProjectProgress(getPool, projects);
    const projectsForView = projects.map((p) => ({
      ...p,
      dashCat: dashboardCategory(p),
    }));
    const firstNonCanceled = projects.find((p) => dashboardCategory(p) !== 'canceled');
    const foundryProjectId = firstNonCanceled ? firstNonCanceled.id : null;

    const subscriptionRow = await getSubscriptionRow(getPool, req.session.userId);
    const priceCfg = getStripePriceConfig();
    const billingSummary = buildBillingSummaryLines(subscriptionRow, priceCfg, res.locals.t);

    const uid = req.session.userId;
    const [ideasRes, publishedRes] = await Promise.all([
      query(
        getPool,
        `SELECT id, research_topic, keywords, notes, created_at
         FROM user_research_ideas WHERE user_id = @uid ORDER BY created_at DESC LIMIT 80`,
        { uid }
      ),
      query(
        getPool,
        `SELECT id, title, date_published, where_published, link, created_at
         FROM user_published_work WHERE user_id = @uid ORDER BY created_at DESC LIMIT 80`,
        { uid }
      ),
    ]);
    const researchIdeas = ideasRes.recordset || [];
    const publishedWork = publishedRes.recordset || [];

    const dashboardClientJson = JSON.stringify({
      projectProgress,
      projects: projectsForView.map((p) => ({ id: p.id, name: p.name, dashCat: p.dashCat })),
    });

    res.render('app/dashboard', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects: projectsForView,
      currentProjectId,
      projectProgress,
      billingSummary,
      foundryProjectId,
      dashboardClientJson,
      researchIdeas,
      publishedWork,
      ...trainingRenderLocals(res),
    });
  })
);

app.get(
  '/billing/checkout',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeBillingConfigured(stripe)) {
      return res.status(503).send(
        `Billing is not configured. Set STRIPE_SECRET_KEY, PUBLIC_BASE_URL, and ${billingPriceEnvHint()} (see README).`
      );
    }
    const cfg = getStripePriceConfig();
    let priceId;
    if (cfg.mode === 'legacy') {
      priceId = cfg.priceId;
    } else {
      const interval = String(req.query.interval || 'month').toLowerCase();
      if (interval === 'year') priceId = cfg.yearly;
      else if (interval === 'month') priceId = cfg.monthly;
      else {
        return res.status(400).send('Invalid interval. Use ?interval=month or ?interval=year');
      }
    }
    const base = String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      locale: i18n.stripeLocale(req.locale),
      success_url: `${base}/app/account?subscription=success`,
      cancel_url: `${base}/app/account?subscription=canceled`,
      client_reference_id: String(req.session.userId),
      customer_email: req.session.user.email,
      subscription_data: {
        metadata: { userId: String(req.session.userId) },
      },
      metadata: { userId: String(req.session.userId) },
    });
    if (!checkoutSession.url) return res.status(500).send('Checkout session did not return a URL');
    res.redirect(303, checkoutSession.url);
  })
);

app.get(
  '/billing/subscribe',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    if (!isStripeBillingConfigured(stripe)) {
      return res.status(503).send(
        `Billing is not configured. Set STRIPE_SECRET_KEY, PUBLIC_BASE_URL, and ${billingPriceEnvHint()} (see README).`
      );
    }
    if (!isStripeElementsBillingConfigured(stripe)) {
      const cfg = getStripePriceConfig();
      if (cfg.mode === 'dual') {
        const interval = String(req.query.interval || 'month').toLowerCase();
        const q =
          interval === 'year' ? 'year' : interval === 'month' ? 'month' : 'month';
        return res.redirect(302, `/billing/checkout?interval=${encodeURIComponent(q)}`);
      }
      return res.redirect(302, '/billing/checkout');
    }
    if (res.locals.appAccess && res.locals.appAccess.paid) {
      return res.redirect('/app/account');
    }
    const cfg = getStripePriceConfig();
    let billingInterval = 'month';
    if (cfg.mode === 'dual') {
      const interval = String(req.query.interval || 'month').toLowerCase();
      if (interval === 'year') billingInterval = 'year';
      else if (interval !== 'month') {
        return res.status(400).send('Invalid interval. Use ?interval=month or ?interval=year');
      }
    }
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = null;
    const intervalLabel =
      cfg.mode === 'dual'
        ? billingInterval === 'year'
          ? res.locals.t('billing.intervalYearly')
          : res.locals.t('billing.intervalMonthly')
        : res.locals.t('billing.plan.member');
    const promoPrefill = String(req.query.promo || '').trim();
    res.render('app/billing-subscribe', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      stripePublishableKey: getStripePublishableKey(),
      stripeLocale: res.locals.stripeLocale,
      billingInterval,
      billingPriceMode: cfg.mode,
      intervalLabel,
      promoPrefill,
      ...trainingRenderLocals(res),
    });
  })
);

app.get(
  '/billing/portal',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeBillingConfigured(stripe)) {
      return res.status(503).send(
        `Billing is not configured. Set STRIPE_SECRET_KEY, PUBLIC_BASE_URL, and ${billingPriceEnvHint()} (see README).`
      );
    }
    await ensureSubscriptionRow(getPool, req.session.userId);
    const customerId = await getExistingValidStripeCustomerId(stripe, getPool, req.session.userId);
    if (!customerId) {
      return res.redirect(302, '/app/account?billing=portal_no_customer');
    }
    const base = String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${base}/app/account?billing=portal_return`,
        locale: i18n.stripeLocale(req.locale),
      });
      if (!portalSession.url) {
        return res.redirect(302, '/app/account?billing=portal_error');
      }
      return res.redirect(303, portalSession.url);
    } catch (e) {
      console.error('Stripe Customer Portal:', e.message || e);
      return res.redirect(302, '/app/account?billing=portal_error');
    }
  })
);

app.get(
  '/billing/payment-method/return',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!stripe || !isStripeElementsBillingConfigured(stripe)) {
      return res.redirect(302, '/app/account?pm=error');
    }
    const sid = req.query.setup_intent;
    const redirectStatus = req.query.redirect_status;
    if (!sid || redirectStatus !== 'succeeded') {
      return res.redirect(302, '/app/account?pm=error');
    }
    try {
      await applyPaymentMethodFromSetupIntent(stripe, getPool, req.session.userId, sid);
      return res.redirect(302, '/app/account?pm=success');
    } catch (e) {
      console.error('Payment method return:', e.message || e);
      return res.redirect(302, '/app/account?pm=error');
    }
  })
);

app.get(
  '/billing/payment-method',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    if (!isStripeBillingConfigured(stripe)) {
      return res.status(503).send(
        `Billing is not configured. Set STRIPE_SECRET_KEY, PUBLIC_BASE_URL, and ${billingPriceEnvHint()} (see README).`
      );
    }
    if (!isStripeElementsBillingConfigured(stripe)) {
      return res.redirect(302, '/billing/portal');
    }
    await ensureSubscriptionRow(getPool, req.session.userId);
    await ensureStripeCustomer(stripe, getPool, req.session.userId, req.session.user?.email);
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = null;
    res.render('app/billing-payment-method', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      stripePublishableKey: getStripePublishableKey(),
      stripeLocale: res.locals.stripeLocale,
      ...trainingRenderLocals(res),
    });
  })
);

app.get(
  '/app/account',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = null;
    const subQ = req.query.subscription;
    const billingQ = req.query.billing;
    let billingFlash = null;
    const at = (key) => i18n.t(req.locale || 'en', 'account.' + key);
    if (subQ === 'success') {
      billingFlash = {
        kind: 'ok',
        text: at('flashSubSuccess'),
      };
    } else if (subQ === 'canceled') {
      billingFlash = { kind: 'muted', text: at('flashSubCanceled') };
    } else if (billingQ === 'portal_return') {
      billingFlash = {
        kind: 'ok',
        text: at('flashPortalReturn'),
      };
    } else if (billingQ === 'portal_no_customer') {
      billingFlash = {
        kind: 'muted',
        text: at('flashPortalNoCustomer'),
      };
    } else if (billingQ === 'portal_error') {
      billingFlash = {
        kind: 'muted',
        text: at('flashPortalError'),
      };
    } else if (billingQ === 'pm_no_customer') {
      billingFlash = {
        kind: 'muted',
        text: at('flashPmNoCustomer'),
      };
    } else if (req.query.pm === 'success') {
      billingFlash = { kind: 'ok', text: at('flashPmSuccess') };
    } else if (req.query.pm === 'error') {
      billingFlash = {
        kind: 'muted',
        text: at('flashPmError'),
      };
    }
    let subscriptionRow = await getSubscriptionRow(getPool, req.session.userId);
    if (isStripeBillingConfigured(stripe) && subscriptionRow?.stripe_customer_id) {
      await getExistingValidStripeCustomerId(stripe, getPool, req.session.userId);
      subscriptionRow = await getSubscriptionRow(getPool, req.session.userId);
    }
    const profileRow = await getUserProfileRow(getPool, req.session.userId);
    let profile = rowToPublicUser(profileRow);
    if (!profile) {
      profile = {
        id: req.session.userId,
        email: req.session.user.email,
        firstName: req.session.user.firstName,
        lastName: req.session.user.lastName,
        title: '',
        university: '',
        researchFocus: '',
        preferredSearchEngine: '',
        preferredLocale: i18n.normalizeLocale(req.session.locale || 'en'),
      };
    }
    const priceCfg = getStripePriceConfig();
    const hasStripeSecret = !!process.env.STRIPE_SECRET_KEY;
    const hasPublicBaseUrl = !!process.env.PUBLIC_BASE_URL;
    const stripeConfigured = isStripeBillingConfigured(stripe);
    const stripeElementsConfigured = isStripeElementsBillingConfigured(stripe);
    const billingEnvMissing = [];
    if (!hasStripeSecret) billingEnvMissing.push('STRIPE_SECRET_KEY');
    if (!hasPublicBaseUrl) billingEnvMissing.push('PUBLIC_BASE_URL');
    if (priceCfg.mode === 'none') billingEnvMissing.push(billingPriceEnvHint());
    const billingSummary = buildBillingSummaryLines(subscriptionRow, priceCfg, res.locals.t);
    const currentPlanInterval = resolvePlanInterval(subscriptionRow, priceCfg);
    const within30DaysOfRenewal = isWithinDaysBeforePeriodEnd(subscriptionRow, 30);
    const renewalDateLabel = subscriptionRow?.current_period_end
      ? formatLongDate(subscriptionRow.current_period_end)
      : null;
    const subscriptionSuccessReturn = subQ === 'success';
    let billingHistory = [];
    if (isStripeBillingConfigured(stripe) && subscriptionRow && subscriptionRow.stripe_customer_id) {
      try {
        billingHistory = await fetchBillingHistoryForCustomer(
          stripe,
          subscriptionRow.stripe_customer_id,
          30,
          req.locale || 'en'
        );
      } catch (err) {
        console.error('[account] billing history:', err.message || err);
      }
    }
    res.render('app/account', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      billingFlash,
      subscriptionSuccessReturn,
      subscriptionRow,
      billingHistory,
      billingSummary,
      within30DaysOfRenewal,
      renewalDateLabel,
      profile,
      universities: loadUniversities(),
      searchEngines: SEARCH_ENGINE_KEYS_ORDERED,
      allowedTitles: TITLE_KEYS_ORDERED,
      stripeConfigured,
      stripeElementsConfigured,
      billingEnvMissing,
      billingPriceMode: priceCfg.mode,
      currentPlanInterval,
      ...trainingRenderLocals(res),
    });
  })
);

app.get(
  '/app/projects/new',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = null;
    const templateOptions = templateOptionsForForm();
    res.render('app/project-new', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      templateOptions,
      purposes: PURPOSES,
      citationStyles: CITATION_STYLES,
      error: null,
      errorNotice: false,
      form: {},
      ...trainingRenderLocals(res),
    });
  })
);

app.post(
  '/app/projects',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = null;
    const templateOptions = templateOptionsForForm();
    const body = req.body || {};
    const result = await createProject(getPool, req.session.userId, body);
    if (!result.ok) {
      return res.render('app/project-new', {
        user: req.session.user,
        appAccess: res.locals.appAccess,
        projects,
        currentProjectId,
        templateOptions,
        purposes: PURPOSES,
        citationStyles: CITATION_STYLES,
        error: result.error,
        errorNotice: !!result.errorNotice,
        form: {
          name: body.name || '',
          purpose: body.purpose || '',
          purposeOther: body.purposeOther || '',
          citationStyle: body.citationStyle || '',
          templateKey: body.templateKey || '',
        },
        ...trainingRenderLocals(res),
      });
    }
    res.redirect(`/app/project/${result.bundle.project.id}/anvil`);
  })
);

app.get(
  '/app/project/:projectId/settings',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (Number.isNaN(projectId)) return res.status(404).send('Not found');
    const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
    if (!bundle) {
      await respondIfProjectUnavailable(req, res, projectId);
      return;
    }
    const projects = await listProjects(getPool, req.session.userId);
    const tpl = loadTemplates();
    const tkUnderscore = String(bundle.project.template_key || '').replace(/-/g, '_');
    const templateLabelKey = 'projectTemplateLabels.' + tkUnderscore;
    const templateLabelTranslated = res.locals.t(templateLabelKey);
    const templateLabelFallback =
      (tpl[bundle.project.template_key] && tpl[bundle.project.template_key].label) ||
      bundle.project.template_key;
    const templateLabel =
      templateLabelTranslated && templateLabelTranslated !== templateLabelKey
        ? templateLabelTranslated
        : templateLabelFallback;
    res.render('app/project-settings', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId: projectId,
      workspaceSlug: 'settings',
      bundle,
      templateLabel,
      purposes: PURPOSES,
      citationStyles: CITATION_STYLES,
      error: null,
      query: req.query || {},
      ...trainingRenderLocals(res),
    });
  })
);

app.post(
  '/app/project/:projectId/settings',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (Number.isNaN(projectId)) return res.status(404).send('Not found');
    const projects = await listProjects(getPool, req.session.userId);
    const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
    if (!bundle) {
      await respondIfProjectUnavailable(req, res, projectId);
      return;
    }
    const tpl = loadTemplates();
    const tkUnderscore = String(bundle.project.template_key || '').replace(/-/g, '_');
    const templateLabelKey = 'projectTemplateLabels.' + tkUnderscore;
    const templateLabelTranslated = res.locals.t(templateLabelKey);
    const templateLabelFallback =
      (tpl[bundle.project.template_key] && tpl[bundle.project.template_key].label) ||
      bundle.project.template_key;
    const templateLabel =
      templateLabelTranslated && templateLabelTranslated !== templateLabelKey
        ? templateLabelTranslated
        : templateLabelFallback;
    const body = req.body || {};
    const result = await updateProjectSettings(getPool, req.session.userId, projectId, body);
    if (!result.ok) {
      return res.render('app/project-settings', {
        user: req.session.user,
        appAccess: res.locals.appAccess,
        projects,
        currentProjectId: projectId,
        workspaceSlug: 'settings',
        bundle,
        templateLabel,
        purposes: PURPOSES,
        citationStyles: CITATION_STYLES,
        error: result.error,
        query: {},
        ...trainingRenderLocals(res),
      });
    }
    res.redirect(`/app/project/${projectId}/settings?saved=1`);
  })
);

app.get(
  '/app/project/:projectId/:slug',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.projectId, 10);
    const { slug } = req.params;
    if (slug === 'anvil2') {
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return res.redirect(301, `/app/project/${projectId}/anvil${qs}`);
    }
    const phase = WORKSPACE_PHASES[slug];
    if (Number.isNaN(projectId) || !phase) return res.status(404).send('Not found');
    const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
    if (!bundle) {
      await respondIfProjectUnavailable(req, res, projectId);
      return;
    }
    if (slug === 'anvil' && bundle.sections && bundle.sections.length > 0) {
      const q =
        req.query.section != null ? parseInt(String(req.query.section), 10) : NaN;
      const valid =
        !Number.isNaN(q) &&
        bundle.sections.some(function (s) {
          return Number(s.id) === q;
        });
      if (!valid) {
        return res.redirect(
          302,
          `/app/project/${projectId}/${slug}?section=${bundle.sections[0].id}`
        );
      }
    }
    const projects = await listProjects(getPool, req.session.userId);
    const foundryLocked = slug === 'foundry' && !res.locals.appAccess.foundryUnlocked;
    let anvilSections = [];
    let anvilSectionId = null;
    if (bundle.sections && bundle.sections.length) {
      anvilSections = bundle.sections.map(function (s) {
        return { id: s.id, title: s.title, slug: s.slug != null ? String(s.slug) : '' };
      });
      if (slug === 'anvil') {
        const sq =
          req.query.section != null ? parseInt(String(req.query.section), 10) : NaN;
        anvilSectionId = !Number.isNaN(sq) ? sq : null;
      }
    }
    let crucibleSections = [];
    if (slug === 'crucible' && bundle.sections && bundle.sections.length) {
      crucibleSections = bundle.sections.map(function (s) {
        return { id: s.id, title: s.title, slug: s.slug != null ? String(s.slug) : '' };
      });
    }
    const titleKey = WORKSPACE_PHASE_TITLE_KEYS[slug];
    const insightKey = WORKSPACE_PHASE_INSIGHT_KEYS[slug];
    res.render('app/workspace', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId: projectId,
      projectId,
      projectTitle: bundle.project.name,
      phaseTitle: titleKey ? res.locals.t(titleKey) : phase.title,
      phaseSlug: slug,
      foundryLocked,
      insightHint: insightKey ? res.locals.t(insightKey) : phase.insight,
      anvilSections,
      anvilSectionId,
      crucibleSections,
      crucibleCitationStyle: bundle.project.citation_style || 'APA',
      anvilInitialIdleMs: ANVIL_INITIAL_IDLE_MS,
      anvilIncrementalChars: ANVIL_INCREMENTAL_CHARS,
      autosaveCharThreshold: AUTOSAVE_CHAR_THRESHOLD,
      scoreStrongThreshold: SCORE_STRONG_THRESHOLD,
      scoreModerateThreshold: SCORE_MODERATE_THRESHOLD,
      minReviewWords: MIN_REVIEW_WORDS,
      ...trainingRenderLocals(res),
    });
  })
);

/** Locals for register.ejs (billing options for optional subscribe-after-signup). */
function registerPageLocals(form) {
  const cfg = getStripePriceConfig();
  return {
    universities: loadUniversities(),
    searchEngines: SEARCH_ENGINE_KEYS_ORDERED,
    allowedTitles: TITLE_KEYS_ORDERED,
    form: form || {},
    memberSubscribeAvailable: !!(stripe && isStripeBillingConfigured(stripe)),
    billingPriceMode: cfg.mode,
  };
}

async function completeNewUserSessionAfterRegistration(req, res, user, form) {
  const prefLoc = i18n.normalizeLocale(user.preferred_locale || req.locale || 'en');
  req.session.userId = user.id;
  req.session.user = {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
  };
  req.session.locale = prefLoc;
  i18n.setLocaleCookie(res, prefLoc);
  if (req.session.registrationPendingId != null) delete req.session.registrationPendingId;
  await ensureSubscriptionRow(getPool, user.id);

  const wantsMember = form.subscribeChoice === 'member';
  if (wantsMember && stripe && isStripeBillingConfigured(stripe)) {
    const cfg = getStripePriceConfig();
    const interval = cfg.mode === 'dual' ? form.billingInterval : 'month';
    let url = isStripeElementsBillingConfigured(stripe)
      ? `/billing/subscribe?interval=${encodeURIComponent(interval)}`
      : `/billing/checkout?interval=${encodeURIComponent(interval)}`;
    if (form.subscribePromo) {
      url += `&promo=${encodeURIComponent(form.subscribePromo)}`;
    }
    return res.redirect(302, url);
  }
  return res.redirect('/app/dashboard');
}

app.get('/register', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const verifyExpired = req.query.verify === 'expired';
  res.render('register', {
    error: verifyExpired ? res.locals.t('register.errorVerifyExpired') : null,
    verifyExpired: !!verifyExpired,
    ...registerPageLocals({}),
  });
});

app.post('/login', async (req, res) => {
  const { email, password, returnTo } = req.body || {};
  const back = safeReturnTo(returnTo);
  if (!email || !password) {
    return res.redirect(`${back}?error=missing`);
  }
  try {
    const result = await query(
      getPool,
      'SELECT id, first_name, last_name, email, password_hash, preferred_locale FROM users WHERE email = @email',
      { email: email.trim() }
    );
    const user = result.recordset[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.redirect(`${back}?error=invalid`);
    }
    req.session.userId = user.id;
    req.session.user = {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
    };
    const loc = i18n.normalizeLocale(user.preferred_locale || 'en');
    req.session.locale = loc;
    i18n.setLocaleCookie(res, loc);
    await ensureSubscriptionRow(getPool, user.id);
    return res.redirect(back);
  } catch (err) {
    console.error('Login error:', err.message);
    return res.redirect(`${back}?error=server`);
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/');
});

app.get('/forgot-password', (req, res) => {
  const sent = req.query.sent === '1';
  const err = req.query.error || null;
  const prefill = req.session && req.session.user && req.session.user.email ? req.session.user.email : '';
  res.render('forgot-password', {
    user: req.session.user || null,
    prefillEmail: prefill,
    sent,
    error: err,
    mailConfigured: isMailConfigured(),
  });
});

app.post('/forgot-password', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const next = '/forgot-password';
  if (!email) {
    return res.redirect(`${next}?error=missing`);
  }
  try {
    const userId = await findUserIdByEmail(getPool, email);
    if (userId) {
      const base = publicAppOrigin();
      if (!base) {
        console.error('forgot-password: PUBLIC_BASE_URL is not set; cannot build reset link.');
        return res.redirect(`${next}?error=config`);
      }
      const { rawToken } = await createPasswordResetToken(getPool, userId);
      const resetUrl = `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
      const mailResult = await sendPasswordResetEmail({ to: email, resetUrl });
      if (mailResult.skipped) {
        console.warn(
          'Password reset: email not sent (configure SMTP_HOST, MAIL_FROM, SMTP_USER/SMTP_PASS as needed).'
        );
        return res.redirect(`${next}?error=mail`);
      }
      if (!mailResult.ok) {
        console.error('Password reset mail error:', mailResult.error);
        return res.redirect(`${next}?error=send`);
      }
    }
    return res.redirect(`${next}?sent=1`);
  } catch (err) {
    console.error('forgot-password:', err.message);
    return res.redirect(`${next}?error=server`);
  }
});

app.get('/reset-password', async (req, res, next) => {
  try {
    const token = String(req.query.token || '').trim();
    const locals = {
      user: req.session.user || null,
      mailConfigured: isMailConfigured(),
    };
    if (!token) {
      return res.render('reset-password', { ...locals, token: '', invalid: true, error: null });
    }
    const row = await findValidTokenRow(getPool, token);
    if (!row) {
      return res.render('reset-password', { ...locals, token: '', invalid: true, error: 'expired' });
    }
    res.render('reset-password', { ...locals, token, invalid: false, error: null });
  } catch (e) {
    next(e);
  }
});

app.post('/reset-password', async (req, res, next) => {
  try {
    const token = String((req.body && req.body.token) || '').trim();
    const pw = String((req.body && req.body.password) || '');
    const pw2 = String((req.body && req.body.passwordConfirm) || '');
    const locals = { user: req.session.user || null, mailConfigured: isMailConfigured() };
    if (!token) {
      return res.render('reset-password', { ...locals, token: '', invalid: true, error: null });
    }
    if (pw !== pw2) {
      const row = await findValidTokenRow(getPool, token);
      if (!row) {
        return res.render('reset-password', { ...locals, token: '', invalid: true, error: 'expired' });
      }
      return res.render('reset-password', { ...locals, token, invalid: false, error: 'mismatch' });
    }
    const result = await resetPasswordWithToken(getPool, token, pw);
    if (!result.ok) {
      return res.render('reset-password', {
        ...locals,
        token,
        invalid: false,
        error: 'invalid',
        message: result.error,
      });
    }
    return res.redirect('/?signin=1&reset=success');
  } catch (e) {
    next(e);
  }
});

app.post('/register', async (req, res) => {
  const {
    title,
    firstName,
    lastName,
    email,
    password,
    passwordConfirm,
    university,
    researchFocus,
    preferredSearchEngine,
    subscribeChoice: subscribeChoiceRaw,
    billingInterval: billingIntervalRaw,
    subscribePromo: subscribePromoRaw,
  } = req.body || {};

  const subscribeChoice =
    String(subscribeChoiceRaw || 'free').toLowerCase() === 'member' ? 'member' : 'free';
  const billingInterval =
    String(billingIntervalRaw || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  const subscribePromo = String(subscribePromoRaw || '').trim();

  const titleNorm = normalizeTitleToKey((title || '').trim());
  const engineNorm = normalizeSearchEngineToKey((preferredSearchEngine || '').trim());

  const form = {
    title: titleNorm || '',
    firstName: (firstName || '').trim(),
    lastName: (lastName || '').trim(),
    email: (email || '').trim().toLowerCase(),
    university: (university || '').trim(),
    researchFocus: (researchFocus || '').trim(),
    preferredSearchEngine: engineNorm || '',
    subscribeChoice,
    billingInterval,
    subscribePromo,
  };

  const t = res.locals.t;
  const renderErr = (key) =>
    res.render('register', {
      error: t(key),
      verifyExpired: false,
      ...registerPageLocals(form),
    });

  if (!form.title || !isAllowedTitleKey(form.title)) {
    return renderErr('register.errorInvalidTitle');
  }
  if (!form.firstName || !form.lastName || !form.email) {
    return renderErr('register.errorRequiredFields');
  }
  const pw = password || '';
  const pw2 = passwordConfirm || '';
  if (pw.length < 8) {
    return renderErr('register.errorPasswordShort');
  }
  if (pw !== pw2) {
    return renderErr('register.errorPasswordMismatch');
  }

  const uni = form.university || null;
  const research = form.researchFocus || null;
  const engine =
    form.preferredSearchEngine && isAllowedSearchEngineKey(form.preferredSearchEngine)
      ? form.preferredSearchEngine
      : null;

  try {
    const hash = await bcrypt.hash(pw, 10);
    const prefLoc = i18n.normalizeLocale(req.locale || 'en');

    if (isNewUserVerificationEnabled()) {
      const existing = await query(
        getPool,
        'SELECT id FROM users WHERE email = @email LIMIT 1',
        { email: form.email }
      );
      if (existing.recordset && existing.recordset.length) {
        return renderErr('register.errorDuplicateEmail');
      }
      if (!isMailConfigured()) {
        return renderErr('register.errorVerificationMailNotConfigured');
      }
      const created = await createPendingRegistration(getPool, {
        email: form.email,
        passwordHash: hash,
        form,
        preferredLocale: prefLoc,
      });
      if (!created.ok) {
        if (created.error === 'duplicate_user') return renderErr('register.errorDuplicateEmail');
        return renderErr('register.errorGeneric');
      }
      const mailResult = await sendRegistrationVerificationEmail({
        to: form.email,
        code: created.code,
      });
      if (mailResult.skipped || !mailResult.ok) {
        await query(getPool, 'DELETE FROM registration_pending WHERE id = @id', { id: created.pendingId });
        return renderErr('register.errorVerificationMailNotConfigured');
      }
      req.session.registrationPendingId = created.pendingId;
      return res.redirect(302, '/register/verify');
    }

    const existingDirect = await query(
      getPool,
      'SELECT id FROM users WHERE email = @email LIMIT 1',
      { email: form.email }
    );
    if (existingDirect.recordset && existingDirect.recordset.length) {
      return renderErr('register.errorDuplicateEmail');
    }

    await query(
      getPool,
      `INSERT INTO users (title, first_name, last_name, email, password_hash, university, research_focus, preferred_search_engine, preferred_locale)
       VALUES (@title, @first_name, @last_name, @email, @password_hash, @university, @research_focus, @preferred_search_engine, @preferred_locale)`,
      {
        title: form.title,
        first_name: form.firstName,
        last_name: form.lastName,
        email: form.email,
        password_hash: hash,
        university: uni,
        research_focus: research || null,
        preferred_search_engine: engine,
        preferred_locale: prefLoc,
      }
    );

    const result = await query(
      getPool,
      'SELECT id, first_name, last_name, email, preferred_locale FROM users WHERE email = @email',
      { email: form.email }
    );
    const user = result.recordset[0];
    return completeNewUserSessionAfterRegistration(req, res, user, form);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return renderErr('register.errorDuplicateEmail');
    }
    console.error('Register error:', err.message);
    return renderErr('register.errorGeneric');
  }
});

async function renderRegisterVerifyWithPending(req, res, errorMessage) {
  const pid = req.session && req.session.registrationPendingId;
  if (!pid) {
    res.redirect('/register');
    return;
  }
  const { row, expired } = await loadPendingForVerifyPage(getPool, pid);
  if (expired || !row) {
    delete req.session.registrationPendingId;
    res.redirect('/register?verify=expired');
    return;
  }
  const codeSent = new Date(row.code_sent_at);
  const resendAt = new Date(codeSent.getTime() + RESEND_COOLDOWN_MS);
  res.render('register-verify', {
    user: req.session.user || null,
    mailConfigured: isMailConfigured(),
    maskedEmail: maskEmail(row.email),
    resendAtIso: resendAt.toISOString(),
    canResendNow: Date.now() >= resendAt.getTime(),
    error: errorMessage || null,
  });
}

app.get('/register/verify', async (req, res, next) => {
  try {
    if (req.session && req.session.userId) return res.redirect('/');
    const pid = req.session && req.session.registrationPendingId;
    if (!pid) return res.redirect('/register');
    await renderRegisterVerifyWithPending(req, res, null);
  } catch (e) {
    next(e);
  }
});

app.post('/register/verify', async (req, res, next) => {
  try {
    if (req.session && req.session.userId) return res.redirect('/');
    const pid = req.session && req.session.registrationPendingId;
    if (!pid) return res.redirect('/register');
    const code = String((req.body && req.body.code) || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    const t = res.locals.t;
    if (code.length !== 6) {
      return renderRegisterVerifyWithPending(req, res, t('register.errorVerifyCodeInvalid'));
    }
    const result = await verifyCodeAndCompleteUser(getPool, pid, code);
    if (!result.ok) {
      if (result.error === 'expired') {
        delete req.session.registrationPendingId;
        return res.redirect('/register?verify=expired');
      }
      if (result.error === 'wrong_code') {
        return renderRegisterVerifyWithPending(req, res, t('register.errorVerifyWrongCode'));
      }
      if (result.error === 'not_found') {
        delete req.session.registrationPendingId;
        return res.redirect('/register');
      }
      return renderRegisterVerifyWithPending(req, res, t('register.errorGeneric'));
    }
    try {
      return await completeNewUserSessionAfterRegistration(req, res, result.user, result.form);
    } catch (sessionErr) {
      console.error('Register verify session:', sessionErr.message);
      return renderRegisterVerifyWithPending(req, res, t('register.errorGeneric'));
    }
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return renderRegisterVerifyWithPending(req, res, res.locals.t('register.errorDuplicateEmail'));
    }
    console.error('Register verify:', err.message);
    return renderRegisterVerifyWithPending(req, res, res.locals.t('register.errorGeneric'));
  }
});

app.post('/register/resend', async (req, res, next) => {
  try {
    if (req.session && req.session.userId) return res.redirect('/');
    const pid = req.session && req.session.registrationPendingId;
    if (!pid) return res.redirect('/register');
    const t = res.locals.t;
    const out = await resendVerificationCode(getPool, pid);
    if (!out.ok) {
      if (out.error === 'expired') {
        delete req.session.registrationPendingId;
        return res.redirect('/register?verify=expired');
      }
      if (out.error === 'too_soon') {
        return renderRegisterVerifyWithPending(req, res, t('register.errorVerifyResendTooSoon'));
      }
      return res.redirect('/register/verify');
    }
    const row = await getPendingById(getPool, pid);
    if (!row) {
      delete req.session.registrationPendingId;
      return res.redirect('/register');
    }
    const mailResult = await sendRegistrationVerificationEmail({ to: row.email, code: out.code });
    if (mailResult.skipped || !mailResult.ok) {
      return renderRegisterVerifyWithPending(req, res, t('register.errorVerificationMailNotConfigured'));
    }
    return res.redirect('/register/verify');
  } catch (e) {
    next(e);
  }
});

app.get('/register/change-email', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const pid = req.session && req.session.registrationPendingId;
  if (!pid) return res.redirect('/register');
  res.render('register-change-email', {
    user: req.session.user || null,
    mailConfigured: isMailConfigured(),
    error: null,
    email: '',
  });
});

app.post('/register/change-email', async (req, res, next) => {
  try {
    if (req.session && req.session.userId) return res.redirect('/');
    const pid = req.session && req.session.registrationPendingId;
    if (!pid) return res.redirect('/register');
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const t = res.locals.t;
    if (!email) {
      return res.render('register-change-email', {
        user: req.session.user || null,
        mailConfigured: isMailConfigured(),
        error: t('register.errorRequiredFields'),
        email: '',
      });
    }
    const out = await changePendingEmail(getPool, pid, email);
    if (!out.ok) {
      if (out.error === 'duplicate_user') {
        return res.render('register-change-email', {
          user: req.session.user || null,
          mailConfigured: isMailConfigured(),
          error: t('register.errorDuplicateEmail'),
          email,
        });
      }
      if (out.error === 'not_found') {
        delete req.session.registrationPendingId;
        return res.redirect('/register');
      }
      if (out.error === 'expired') {
        delete req.session.registrationPendingId;
        return res.redirect('/register?verify=expired');
      }
      return res.render('register-change-email', {
        user: req.session.user || null,
        mailConfigured: isMailConfigured(),
        error: t('register.errorGeneric'),
        email,
      });
    }
    const mailResult = await sendRegistrationVerificationEmail({ to: out.email, code: out.code });
    if (mailResult.skipped || !mailResult.ok) {
      return res.render('register-change-email', {
        user: req.session.user || null,
        mailConfigured: isMailConfigured(),
        error: t('register.errorVerificationMailNotConfigured'),
        email,
      });
    }
    return res.redirect('/register/verify');
  } catch (e) {
    next(e);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  if (req.path && req.path.startsWith('/api')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(500).send('Something went wrong.');
});

async function start() {
  if (!dbConfig.host || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
    console.error('Missing required env: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD. Copy .env.example to .env and set values.');
    process.exit(1);
  }
  try {
    await getPool();
    await ensureUsersTable();
    await ensureUserExtraColumns();
    await ensureCoreSchema(getPool);
    await initProjectTemplatesStore(getPool);
    await ensureTrainingWalkthroughSchema(getPool);
    await ensurePasswordResetSchema(getPool);
    console.log('Database connected.');
  } catch (err) {
    console.error('Database startup failed:', err.message);
    if (err.code != null) console.error('MySQL error code:', err.code);
    if (err.errno != null) console.error('MySQL errno:', err.errno);
    console.error(err);
    if (err.code === 'ER_BAD_DB_ERROR' || err.errno === 1049) {
      console.error(
        "Hint: DB_NAME must be a MySQL database (schema) you created inside the instance, e.g. academiq_forge — not the Cloud SQL 'instance connection name' (project:region:instance). Create the database in Cloud SQL if it does not exist."
      );
    } else if (/ETIMEOUT|ECONNREFUSED|ETIME|ETIMEDOUT|ECONNRESET|Access denied|access denied/i.test(String(err.message))) {
      console.error(
        'Hint: confirm DB_HOST, DB_PORT (default 3306 for MySQL), DB_NAME, DB_USER, DB_PASSWORD, Cloud SQL authorized networks / static outbound IP on Render, and DB_SSL=true (plus DB_SSL_CA_PEM or DB_SSL_CA_PATH) if the instance requires TLS.'
      );
    }
    process.exit(1);
  }

  if (redisSessionClient) {
    try {
      await redisSessionClient.connect();
      console.log('Session store: Redis');
    } catch (err) {
      console.error('Redis connection failed (REDIS_URL):', err.message);
      process.exit(1);
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.warn(
      'Session store: MemoryStore (not durable across restarts / multiple instances). Set REDIS_URL for production.'
    );
  }

  if (stripe) {
    if (isStripeElementsBillingConfigured(stripe)) {
      console.log('Stripe: on-site billing enabled (Account → /billing/subscribe).');
    } else if (isStripeBillingConfigured(stripe)) {
      console.log(
        'Stripe: hosted Checkout only. Add STRIPE_PUBLISHABLE_KEY (pk_...) to enable on-site payment on Account.'
      );
      const rawPk = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
      if (rawPk.startsWith('sk_')) {
        console.warn(
          'Stripe: STRIPE_PUBLISHABLE_KEY looks like a secret key (sk_). Use the publishable key (pk_) from Developers → API keys.'
        );
      }
    }
  }

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => {
    if (redisSessionClient) {
      redisSessionClient.quit().catch(() => {});
    }
  });
}

start();
