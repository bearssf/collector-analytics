'use strict';

const { query } = require('./db');

async function ensureSubscriptionRow(getPool, userId) {
  const r = await query(
    getPool,
    'SELECT id FROM subscriptions WHERE user_id = @user_id',
    { user_id: userId }
  );
  if (r.recordset[0]) return;
  await query(
    getPool,
    `INSERT INTO subscriptions (user_id, status, trial_end, updated_at)
     VALUES (@user_id, 'trialing', DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
    { user_id: userId }
  );
}

async function getSubscriptionRow(getPool, userId) {
  const r = await query(getPool, 'SELECT * FROM subscriptions WHERE user_id = @user_id', {
    user_id: userId,
  });
  return r.recordset[0] || null;
}

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
    cancelAtPeriodEnd,
  } = fields;
  await ensureSubscriptionRow(getPool, userId);
  const cap = cancelAtPeriodEnd === true ? 1 : 0;
  await query(
    getPool,
    `UPDATE subscriptions SET
        stripe_customer_id = @stripe_customer_id,
        stripe_subscription_id = @stripe_subscription_id,
        status = @status,
        current_period_end = @current_period_end,
        \`plan\` = @plan,
        cancel_at_period_end = @cancel_at_period_end,
        updated_at = NOW()
       WHERE user_id = @user_id`,
    {
      user_id: userId,
      stripe_customer_id: stripeCustomerId || null,
      stripe_subscription_id: stripeSubscriptionId || null,
      status,
      current_period_end: currentPeriodEnd || null,
      plan: plan || 'member',
      cancel_at_period_end: cap,
    }
  );
}

async function findUserIdByStripeSubscriptionId(getPool, subscriptionId) {
  const r = await query(
    getPool,
    'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = @sid',
    { sid: subscriptionId }
  );
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
