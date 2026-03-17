require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const path = require('path');

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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'collector-analytics-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 },
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
      first_name NVARCHAR(100) NOT NULL,
      last_name NVARCHAR(100) NOT NULL,
      email NVARCHAR(255) NOT NULL UNIQUE,
      password_hash NVARCHAR(255) NOT NULL,
      created_at DATETIME2 DEFAULT GETDATE()
    );
  `);
}

app.use(async (req, res, next) => {
  try {
    await ensureUsersTable();
    next();
  } catch (err) {
    console.error('DB init error:', err.message);
    next(err);
  }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/');
}

app.get('/', (req, res) => {
  res.render('home', {
    user: req.session.user || null,
    error: req.query.error || null,
  });
});

app.get('/register', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('register', { error: null });
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
  const { firstName, lastName, email, password } = req.body || {};
  const first = (firstName || '').trim();
  const last = (lastName || '').trim();
  const em = (email || '').trim().toLowerCase();
  const pw = password || '';

  if (!first || !last || !em || !pw) {
    return res.render('register', { error: 'All fields are required.' });
  }
  if (pw.length < 6) {
    return res.render('register', { error: 'Password must be at least 6 characters.' });
  }

  try {
    const hash = await bcrypt.hash(pw, 10);
    const p = await getPool();
    await p
      .request()
      .input('first_name', sql.NVarChar(100), first)
      .input('last_name', sql.NVarChar(100), last)
      .input('email', sql.NVarChar(255), em)
      .input('password_hash', sql.NVarChar(255), hash)
      .query(
        `INSERT INTO users (first_name, last_name, email, password_hash)
         VALUES (@first_name, @last_name, @email, @password_hash)`
      );

    const result = await p
      .request()
      .input('email', sql.NVarChar(255), em)
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
      return res.render('register', { error: 'An account with that email already exists.' });
    }
    console.error('Register error:', err.message);
    return res.render('register', { error: 'Registration failed. Please try again.' });
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
