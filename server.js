require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const path = require('path');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' }) : null;

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

// Stripe webhook must use raw body (before express.json())
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' }) : null;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) return res.status(500).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  (async () => {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id ? parseInt(session.client_reference_id, 10) : null;
      if (!userId || !session.subscription) return;
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = sub.items.data[0]?.price?.id;
      const plan = priceId === process.env.STRIPE_YEARLY_PRICE_ID ? 'yearly' : 'monthly';
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
      const p = await getPool();
      await p.request()
        .input('user_id', sql.Int, userId)
        .input('stripe_customer_id', sql.NVarChar(255), session.customer || null)
        .input('stripe_subscription_id', sql.NVarChar(255), sub.id)
        .input('plan', sql.NVarChar(20), plan)
        .input('status', sql.NVarChar(20), sub.status)
        .input('current_period_end', sql.DateTime2, periodEnd)
        .query(`
          MERGE subscriptions AS t
          USING (SELECT @user_id AS user_id) AS s ON t.user_id = s.user_id
          WHEN MATCHED THEN UPDATE SET stripe_customer_id = @stripe_customer_id, stripe_subscription_id = @stripe_subscription_id, plan = @plan, status = @status, current_period_end = @current_period_end, updated_at = GETDATE()
          WHEN NOT MATCHED THEN INSERT (user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end) VALUES (@user_id, @stripe_customer_id, @stripe_subscription_id, @plan, @status, @current_period_end);
        `);
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const plan = sub.items?.data?.[0]?.price?.id === process.env.STRIPE_YEARLY_PRICE_ID ? 'yearly' : 'monthly';
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
      const p = await getPool();
      await p.request()
        .input('stripe_subscription_id', sql.NVarChar(255), sub.id)
        .input('plan', sql.NVarChar(20), plan)
        .input('status', sql.NVarChar(20), sub.status)
        .input('current_period_end', sql.DateTime2, periodEnd)
        .query(`
          UPDATE subscriptions SET plan = @plan, status = @status, current_period_end = @current_period_end, updated_at = GETDATE() WHERE stripe_subscription_id = @stripe_subscription_id
        `);
    }
  })().catch((err) => console.error('Webhook handler error:', err));
  res.json({ received: true });
});

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

async function ensureSubscriptionsTable() {
  const p = await getPool();
  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'subscriptions')
    CREATE TABLE subscriptions (
      id INT IDENTITY(1,1) PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      stripe_customer_id NVARCHAR(255) NULL,
      stripe_subscription_id NVARCHAR(255) NULL,
      plan NVARCHAR(20) NOT NULL,
      status NVARCHAR(20) NOT NULL,
      current_period_end DATETIME2 NULL,
      created_at DATETIME2 DEFAULT GETDATE(),
      updated_at DATETIME2 DEFAULT GETDATE(),
      CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

async function getSubscription(userId) {
  const p = await getPool();
  const r = await p.request().input('user_id', sql.Int, userId).query(`
    SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = @user_id AND status = 'active' AND (current_period_end IS NULL OR current_period_end > GETDATE())
  `);
  return r.recordset[0] || null;
}

app.use(async (req, res, next) => {
  try {
    await ensureUsersTable();
    await ensureSubscriptionsTable();
    next();
  } catch (err) {
    console.error('DB init error:', err.message);
    next(err);
  }
});

async function loadUserSubscription(req, res, next) {
  if (req.session && req.session.userId && req.session.user) {
    try {
      req.session.user.subscription = await getSubscription(req.session.userId) || null;
    } catch (e) {
      req.session.user.subscription = null;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/');
}

function requireSubscription(req, res, next) {
  const sub = req.session?.user?.subscription;
  if (sub && sub.status === 'active') return next();
  res.redirect('/subscribe');
}

app.use(loadUserSubscription);

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

app.get('/subscribe', requireAuth, (req, res) => {
  if (req.session.user.subscription?.status === 'active') return res.redirect('/members');
  res.render('subscribe', { user: req.session.user, error: req.query.error });
});

app.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  const priceId = plan === 'yearly' ? process.env.STRIPE_YEARLY_PRICE_ID : process.env.STRIPE_MONTHLY_PRICE_ID;
  if (!stripe || !priceId) return res.status(400).send('Subscription not configured');
  const user = req.session.user;
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email,
      client_reference_id: String(user.id),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/subscribe`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.redirect('/subscribe?error=checkout');
  }
});

app.get('/subscribe/success', requireAuth, async (req, res) => {
  req.session.user.subscription = await getSubscription(req.session.userId) || null;
  res.render('subscribe-success', { user: req.session.user });
});

app.get('/members', requireAuth, requireSubscription, (req, res) => {
  res.render('members', { user: req.session.user });
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
    await ensureUsersTable();
    await ensureSubscriptionsTable();
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
