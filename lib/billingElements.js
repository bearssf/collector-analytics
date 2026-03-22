const sql = require('mssql');
const { ensureSubscriptionRow, getSubscriptionRow } = require('./subscriptions');

function resolvePriceIdFromRequest(intervalQuery, cfg) {
  if (cfg.mode === 'legacy') return cfg.priceId;
  const interval = String(intervalQuery || 'month').toLowerCase();
  if (interval === 'year') return cfg.yearly;
  if (interval === 'month') return cfg.monthly;
  return null;
}

/**
 * @param {import('stripe').default} stripe
 */
async function ensureStripeCustomer(stripe, getPool, userId, email) {
  await ensureSubscriptionRow(getPool, userId);
  const row = await getSubscriptionRow(getPool, userId);
  if (row && row.stripe_customer_id) {
    return row.stripe_customer_id;
  }
  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { userId: String(userId) },
  });
  const p = await getPool();
  await p
    .request()
    .input('user_id', sql.Int, userId)
    .input('stripe_customer_id', sql.NVarChar(255), customer.id)
    .query(
      `UPDATE subscriptions SET stripe_customer_id = @stripe_customer_id, updated_at = GETDATE()
       WHERE user_id = @user_id`
    );
  return customer.id;
}

/**
 * @param {import('stripe').default} stripe
 */
async function createSubscriptionPaymentIntentClientSecret(stripe, getPool, userId, email, priceId) {
  const customerId = await ensureStripeCustomer(stripe, getPool, userId, email);
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: { userId: String(userId) },
  });
  const inv = subscription.latest_invoice;
  const pi = inv && typeof inv === 'object' ? inv.payment_intent : null;
  const secret =
    pi && typeof pi === 'object' && pi.client_secret ? pi.client_secret : null;
  if (!secret) {
    const err = new Error('Stripe subscription did not return a payment client secret');
    err.code = 'STRIPE_NO_CLIENT_SECRET';
    throw err;
  }
  return { clientSecret: secret, subscriptionId: subscription.id };
}

module.exports = {
  resolvePriceIdFromRequest,
  ensureStripeCustomer,
  createSubscriptionPaymentIntentClientSecret,
};
