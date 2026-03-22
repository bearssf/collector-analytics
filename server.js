require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

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
  templateOptionsForForm,
  updateProjectSettings,
  PURPOSES,
  CITATION_STYLES,
} = require('./lib/projectService');
const { ALLOWED_TITLES, SEARCH_ENGINES } = require('./lib/userConstants');
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
const { applyPaymentMethodFromSetupIntent } = require('./lib/billingPaymentMethod');

const app = express();

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}
const PORT = process.env.PORT || 3000;

const dbConfig = {
  server: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '30000', 10),
  requestTimeout: parseInt(process.env.DB_REQUEST_TIMEOUT_MS || '30000', 10),
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
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
  pool = await sql.connect(dbConfig);
  return pool;
}

app.use('/api', createApiRouter(getPool));
app.use('/api/billing', createBillingApiRouter(getPool, stripe));

async function ensureUsersTable() {
  const p = await getPool();
  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'users')
    CREATE TABLE users (
      id INT IDENTITY(1,1) PRIMARY KEY,
      title NVARCHAR(20) NULL,
      first_name NVARCHAR(100) NOT NULL,
      last_name NVARCHAR(100) NOT NULL,
      email NVARCHAR(255) NOT NULL UNIQUE,
      password_hash NVARCHAR(255) NOT NULL,
      university NVARCHAR(255) NULL,
      research_focus NVARCHAR(MAX) NULL,
      preferred_search_engine NVARCHAR(100) NULL,
      created_at DATETIME2 DEFAULT GETDATE()
    );
  `);
}

async function ensureUserExtraColumns() {
  const p = await getPool();
  const cols = [
    { name: 'title', def: 'NVARCHAR(20) NULL' },
    { name: 'university', def: 'NVARCHAR(255) NULL' },
    { name: 'research_focus', def: 'NVARCHAR(MAX) NULL' },
    { name: 'preferred_search_engine', def: 'NVARCHAR(100) NULL' },
  ];
  for (const { name, def } of cols) {
    await p.request().query(`
      IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('users') AND name = '${name}'
      )
      ALTER TABLE users ADD ${name} ${def};
    `);
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

app.get('/', (req, res) => {
  const next = req.query.next ? safeReturnTo(req.query.next) : '/';
  res.render('home', {
    user: req.session.user || null,
    error: req.query.error || null,
    returnTo: next,
    openSignin: req.query.signin === '1',
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
  });
});

const WORKSPACE_PHASES = {
  anvil: { title: 'The Anvil', insight: 'Paragraph feedback, scoring, and citations will appear here.' },
  crucible: { title: 'The Crucible', insight: 'Source lists, notes, and Semantic Scholar suggestions will appear here.' },
  foundry: { title: 'The Foundry', insight: 'Generated research topics and gaps will appear here for paid members.' },
  framework: { title: 'Framework', insight: 'Argument outline and evidence mapping will appear here.' },
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
    res.render('app/dashboard', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
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
      cfg.mode === 'dual' ? (billingInterval === 'year' ? 'Yearly' : 'Monthly') : 'Member';
    res.render('app/billing-subscribe', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      stripePublishableKey: getStripePublishableKey(),
      billingInterval,
      billingPriceMode: cfg.mode,
      intervalLabel,
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
    const subRow = await getSubscriptionRow(getPool, req.session.userId);
    if (!subRow || !subRow.stripe_customer_id) {
      return res.redirect(302, '/app/account?billing=portal_no_customer');
    }
    const base = String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: subRow.stripe_customer_id,
        return_url: `${base}/app/account?billing=portal_return`,
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
    const subRow = await getSubscriptionRow(getPool, req.session.userId);
    if (!subRow?.stripe_customer_id) {
      return res.redirect(302, '/app/account?billing=pm_no_customer');
    }
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = null;
    res.render('app/billing-payment-method', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      stripePublishableKey: getStripePublishableKey(),
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
    if (subQ === 'success') {
      billingFlash = {
        kind: 'ok',
        text: 'Thanks — payment submitted. Member access activates when Stripe confirms (usually seconds).',
      };
    } else if (subQ === 'canceled') {
      billingFlash = { kind: 'muted', text: 'Checkout was canceled. No charges were made.' };
    } else if (billingQ === 'portal_return') {
      billingFlash = {
        kind: 'ok',
        text: 'You’re back from the billing portal. Subscription changes usually show here within a few seconds.',
      };
    } else if (billingQ === 'portal_no_customer') {
      billingFlash = {
        kind: 'muted',
        text: 'Manage billing is available after you have a Stripe customer (subscribe to a plan first).',
      };
    } else if (billingQ === 'portal_error') {
      billingFlash = {
        kind: 'muted',
        text:
          'Could not open the billing portal. In the Stripe Dashboard, enable Customer Portal (Settings → Billing → Customer portal) and try again.',
      };
    } else if (billingQ === 'pm_no_customer') {
      billingFlash = {
        kind: 'muted',
        text: 'Add a subscription first so we have a Stripe customer to attach a card to.',
      };
    } else if (req.query.pm === 'success') {
      billingFlash = { kind: 'ok', text: 'Payment method updated.' };
    } else if (req.query.pm === 'error') {
      billingFlash = {
        kind: 'muted',
        text: 'Could not update payment method. Try again or use Manage billing.',
      };
    }
    const subscriptionRow = await getSubscriptionRow(getPool, req.session.userId);
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
    const billingSummary = buildBillingSummaryLines(subscriptionRow, priceCfg);
    const currentPlanInterval = resolvePlanInterval(subscriptionRow, priceCfg);
    const within30DaysOfRenewal = isWithinDaysBeforePeriodEnd(subscriptionRow, 30);
    const renewalDateLabel = subscriptionRow?.current_period_end
      ? formatLongDate(subscriptionRow.current_period_end)
      : null;
    const subscriptionSuccessReturn = subQ === 'success';
    res.render('app/account', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      billingFlash,
      subscriptionSuccessReturn,
      subscriptionRow,
      billingSummary,
      within30DaysOfRenewal,
      renewalDateLabel,
      profile,
      universities: loadUniversities(),
      searchEngines: SEARCH_ENGINES,
      allowedTitles: ALLOWED_TITLES,
      stripeConfigured,
      stripeElementsConfigured,
      billingEnvMissing,
      billingPriceMode: priceCfg.mode,
      currentPlanInterval,
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
    if (!bundle) return res.status(404).send('Not found');
    const projects = await listProjects(getPool, req.session.userId);
    const tpl = loadTemplates();
    const templateLabel = tpl[bundle.project.template_key]
      ? tpl[bundle.project.template_key].label
      : bundle.project.template_key;
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
    if (!bundle) return res.status(404).send('Not found');
    const tpl = loadTemplates();
    const templateLabel = tpl[bundle.project.template_key]
      ? tpl[bundle.project.template_key].label
      : bundle.project.template_key;
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
    const phase = WORKSPACE_PHASES[slug];
    if (Number.isNaN(projectId) || !phase) return res.status(404).send('Not found');
    const bundle = await getProjectBundle(getPool, projectId, req.session.userId);
    if (!bundle) return res.status(404).send('Not found');
    if (
      slug === 'anvil' &&
      bundle.sections &&
      bundle.sections.length > 0
    ) {
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
          `/app/project/${projectId}/anvil?section=${bundle.sections[0].id}`
        );
      }
    }
    const projects = await listProjects(getPool, req.session.userId);
    const foundryLocked = slug === 'foundry' && !res.locals.appAccess.foundryUnlocked;
    let anvilSections = [];
    let anvilSectionId = null;
    if (slug === 'anvil' && bundle.sections && bundle.sections.length) {
      anvilSections = bundle.sections.map(function (s) {
        return { id: s.id, title: s.title };
      });
      const sq =
        req.query.section != null ? parseInt(String(req.query.section), 10) : NaN;
      anvilSectionId = !Number.isNaN(sq) ? sq : null;
    }
    res.render('app/workspace', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId: projectId,
      projectId,
      projectTitle: bundle.project.name,
      phaseTitle: phase.title,
      phaseSlug: slug,
      foundryLocked,
      insightHint: phase.insight,
      anvilSections,
      anvilSectionId,
    });
  })
);

app.get('/register', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('register', {
    error: null,
    universities: loadUniversities(),
    searchEngines: SEARCH_ENGINES,
    allowedTitles: ALLOWED_TITLES,
    form: {},
  });
});

app.post('/login', async (req, res) => {
  const { email, password, returnTo } = req.body || {};
  const back = safeReturnTo(returnTo);
  if (!email || !password) {
    return res.redirect(`${back}?error=missing`);
  }
  try {
    const p = await getPool();
    const result = await p
      .request()
      .input('email', sql.NVarChar(255), email.trim())
      .query(
        'SELECT id, first_name, last_name, email, password_hash FROM users WHERE email = @email'
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
  } = req.body || {};

  const form = {
    title: (title || '').trim(),
    firstName: (firstName || '').trim(),
    lastName: (lastName || '').trim(),
    email: (email || '').trim().toLowerCase(),
    university: (university || '').trim(),
    researchFocus: (researchFocus || '').trim(),
    preferredSearchEngine: (preferredSearchEngine || '').trim(),
  };

  const renderErr = (msg) =>
    res.render('register', {
      error: msg,
      universities: loadUniversities(),
      searchEngines: SEARCH_ENGINES,
      allowedTitles: ALLOWED_TITLES,
      form,
    });

  if (!form.title || !ALLOWED_TITLES.includes(form.title)) {
    return renderErr('Please select a valid title.');
  }
  if (!form.firstName || !form.lastName || !form.email) {
    return renderErr('First name, last name, and email are required.');
  }
  const pw = password || '';
  const pw2 = passwordConfirm || '';
  if (pw.length < 8) {
    return renderErr('Password must be at least 8 characters.');
  }
  if (pw !== pw2) {
    return renderErr('Password and confirmation do not match.');
  }

  const uni = form.university || null;
  const research = form.researchFocus || null;
  const engine = form.preferredSearchEngine || null;

  try {
    const hash = await bcrypt.hash(pw, 10);
    const p = await getPool();
    await p
      .request()
      .input('title', sql.NVarChar(20), form.title)
      .input('first_name', sql.NVarChar(100), form.firstName)
      .input('last_name', sql.NVarChar(100), form.lastName)
      .input('email', sql.NVarChar(255), form.email)
      .input('password_hash', sql.NVarChar(255), hash)
      .input('university', sql.NVarChar(255), uni)
      .input('research_focus', sql.NVarChar(4000), research || null)
      .input('preferred_search_engine', sql.NVarChar(100), engine)
      .query(
        `INSERT INTO users (title, first_name, last_name, email, password_hash, university, research_focus, preferred_search_engine)
         VALUES (@title, @first_name, @last_name, @email, @password_hash, @university, @research_focus, @preferred_search_engine)`
      );

    const result = await p
      .request()
      .input('email', sql.NVarChar(255), form.email)
      .query(
        'SELECT id, first_name, last_name, email FROM users WHERE email = @email'
      );
    const user = result.recordset[0];
    req.session.userId = user.id;
    req.session.user = {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
    };
    await ensureSubscriptionRow(getPool, user.id);
    return res.redirect('/');
  } catch (err) {
    if (err.number === 2627 || err.code === 'EREQUEST') {
      return renderErr('An account with that email already exists.');
    }
    console.error('Register error:', err.message);
    return renderErr('Registration failed. Please try again.');
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
  if (!dbConfig.server || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
    console.error('Missing required env: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD. Copy .env.example to .env and set values.');
    process.exit(1);
  }
  try {
    await getPool();
    await ensureUsersTable();
    await ensureUserExtraColumns();
    await ensureCoreSchema(getPool);
    console.log('Database connected.');
  } catch (err) {
    console.error('Database startup failed:', err.message);
    if (err.number != null) console.error('SQL error number:', err.number);
    if (err.lineNumber != null) console.error('SQL line:', err.lineNumber);
    if (Array.isArray(err.precedingErrors) && err.precedingErrors.length) {
      console.error('Preceding SQL errors (root cause):');
      err.precedingErrors.forEach((e, i) => console.error(`  [${i}]`, e.message || e, e.number != null ? `(#${e.number})` : ''));
    }
    console.error(err);
    if (/ETIMEOUT|ECONNREFUSED|ETIME|ETIMEDOUT|login failed|Login failed/i.test(String(err.message))) {
      console.error(
        'Hint: connection issues often mean Azure SQL is blocking Render. Enable public access on the SQL server, ' +
          'add firewall rules for your Render service Outbound IP ranges (Dashboard → service → Outbound), ' +
          'and confirm DB_HOST / DB_PORT in Render env vars.'
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
