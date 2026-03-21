const sql = require('mssql');

async function ensureSubscriptionRow(getPool, userId) {
  const p = await getPool();
  const r = await p
    .request()
    .input('user_id', sql.Int, userId)
    .query('SELECT id FROM subscriptions WHERE user_id = @user_id');
  if (r.recordset[0]) return;
  await p
    .request()
    .input('user_id', sql.Int, userId)
    .query(
      `INSERT INTO subscriptions (user_id, status, trial_end, updated_at)
       VALUES (@user_id, 'trialing', DATEADD(day, 7, GETDATE()), GETDATE())`
    );
}

async function getSubscriptionRow(getPool, userId) {
  const p = await getPool();
  const r = await p
    .request()
    .input('user_id', sql.Int, userId)
    .query('SELECT * FROM subscriptions WHERE user_id = @user_id');
  return r.recordset[0] || null;
}

/**
 * Foundry: paid (active subscription) only — not included in trial.
 */
function appAccessFromRow(row) {
  if (!row) {
    return {
      paid: false,
      trialing: false,
      trialEndsAt: null,
      trialEndsLabel: '',
      foundryUnlocked: false,
    };
  }
  const now = Date.now();
  const trialEndMs = row.trial_end ? new Date(row.trial_end).getTime() : 0;
  const paid = row.status === 'active';
  const trialing = row.status === 'trialing' && trialEndMs > now;
  return {
    paid,
    trialing,
    trialEndsAt: row.trial_end ? new Date(row.trial_end) : null,
    trialEndsLabel: row.trial_end
      ? new Date(row.trial_end).toLocaleDateString(undefined, { dateStyle: 'medium' })
      : '',
    foundryUnlocked: paid,
  };
}

async function applyStripeSubscriptionToUser(getPool, userId, fields) {
  const {
    stripeCustomerId,
    stripeSubscriptionId,
    status,
    currentPeriodEnd,
    plan,
  } = fields;
  await ensureSubscriptionRow(getPool, userId);
  const p = await getPool();
  await p
    .request()
    .input('user_id', sql.Int, userId)
    .input('stripe_customer_id', sql.NVarChar(255), stripeCustomerId || null)
    .input('stripe_subscription_id', sql.NVarChar(255), stripeSubscriptionId || null)
    .input('status', sql.NVarChar(40), status)
    .input('current_period_end', sql.DateTime2, currentPeriodEnd || null)
    .input('plan', sql.NVarChar(20), plan || 'member')
    .query(
      `UPDATE subscriptions SET
        stripe_customer_id = @stripe_customer_id,
        stripe_subscription_id = @stripe_subscription_id,
        status = @status,
        current_period_end = @current_period_end,
        [plan] = @plan,
        updated_at = GETDATE()
       WHERE user_id = @user_id`
    );
}

async function findUserIdByStripeSubscriptionId(getPool, subscriptionId) {
  const p = await getPool();
  const r = await p
    .request()
    .input('sid', sql.NVarChar(255), subscriptionId)
    .query('SELECT user_id FROM subscriptions WHERE stripe_subscription_id = @sid');
  const row = r.recordset[0];
  return row ? row.user_id : null;
}

module.exports = {
  ensureSubscriptionRow,
  getSubscriptionRow,
  appAccessFromRow,
  applyStripeSubscriptionToUser,
  findUserIdByStripeSubscriptionId,
};
