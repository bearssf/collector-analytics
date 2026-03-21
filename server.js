require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const { ensureCoreSchema } = require('./lib/schema');
const { ensureSubscriptionRow, getSubscriptionRow, appAccessFromRow } = require('./lib/subscriptions');
const {
  listProjects,
  getProjectBundle,
  createProject,
  loadTemplates,
  PURPOSES,
  CITATION_STYLES,
} = require('./lib/projectService');
const createApiRouter = require('./routes/api');

const app = express();
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
app.use(express.json({ limit: '2mb' }));

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-change-session-secret';
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  })
);

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

const SEARCH_ENGINES = [
  'Google Scholar',
  'Worldcat.org',
  'PubMed Central',
  'JSTOR',
  'CORE',
  'Semantic Scholar',
  'ResearchGate',
  'Lens.org',
  'Other/University Specific',
];

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
    const currentProjectId = projects.length ? projects[0].id : null;
    res.render('app/dashboard', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
    });
  })
);

app.get(
  '/app/account',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = projects.length ? projects[0].id : null;
    res.render('app/account', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
    });
  })
);

app.get(
  '/app/projects/new',
  requireAuth,
  asyncHandler(loadAppAccess),
  asyncHandler(async (req, res) => {
    const projects = await listProjects(getPool, req.session.userId);
    const currentProjectId = projects.length ? projects[0].id : null;
    const tpl = loadTemplates();
    const templateOptions = Object.keys(tpl).map((k) => ({ key: k, label: tpl[k].label }));
    res.render('app/project-new', {
      user: req.session.user,
      appAccess: res.locals.appAccess,
      projects,
      currentProjectId,
      templateOptions,
      purposes: PURPOSES,
      citationStyles: CITATION_STYLES,
      error: null,
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
    const currentProjectId = projects.length ? projects[0].id : null;
    const tpl = loadTemplates();
    const templateOptions = Object.keys(tpl).map((k) => ({ key: k, label: tpl[k].label }));
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
        form: {
          name: body.name || '',
          purpose: body.purpose || '',
          citationStyle: body.citationStyle || '',
          templateKey: body.templateKey || '',
        },
      });
    }
    res.redirect(`/app/project/${result.bundle.project.id}/anvil`);
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
    const projects = await listProjects(getPool, req.session.userId);
    const foundryLocked = slug === 'foundry' && !res.locals.appAccess.foundryUnlocked;
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
    });
  })
);

app.get('/register', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('register', {
    error: null,
    universities: loadUniversities(),
    searchEngines: SEARCH_ENGINES,
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

  const allowedTitles = ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Mx.', 'Dr.'];
  const renderErr = (msg) =>
    res.render('register', {
      error: msg,
      universities: loadUniversities(),
      searchEngines: SEARCH_ENGINES,
      form,
    });

  if (!form.title || !allowedTitles.includes(form.title)) {
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
    console.error('Database connection failed:', err.message);
    console.error(
      'Hint: timeouts usually mean Azure SQL is blocking Render. Enable public access on the SQL server, ' +
        'add firewall rules for your Render service Outbound IP ranges (Dashboard → service → Outbound), ' +
        'and confirm DB_HOST / DB_PORT in Render env vars.'
    );
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

start();
