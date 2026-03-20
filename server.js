require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const dbConfig = {
  server: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
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

let pool = null;

async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(dbConfig);
  return pool;
}

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

app.get('/', (req, res) => {
  res.render('home', {
    user: req.session.user || null,
    error: req.query.error || null,
  });
});

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
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.redirect('/?error=missing');
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
      return res.redirect('/?error=invalid');
    }
    req.session.userId = user.id;
    req.session.user = {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
    };
    return res.redirect('/');
  } catch (err) {
    console.error('Login error:', err.message);
    return res.redirect('/?error=server');
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
    console.log('Database connected.');
  } catch (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

start();
