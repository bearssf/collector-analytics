const { query } = require('./db');
const { ensureSubscriptionRow, getSubscriptionRow } = require('./subscriptions');

function isStripeCustomerMissingError(e) {
  if (!e) return false;
  if (e.code === 'resource_missing') return true;
  const msg = e.message != null ? String(e.message) : '';
  return /no such customer/i.test(msg);
}

function resolvePriceIdFromRequest(intervalQuery, cfg) {
  if (cfg.mode === 'legacy') return cfg.priceId;
  const interval = String(intervalQuery || 'month').toLowerCase();
  if (interval === 'year') return cfg.yearly;
  if (interval === 'month') return cfg.monthly;
  return null;
}

/**
 * Return stored customer id only if it still exists in Stripe; clear DB if Stripe says missing.
 * Does not create a customer (use for Customer Portal — user should subscribe first).
 */
async function getExistingValidStripeCustomerId(stripe, getPool, userId) {
  await ensureSubscriptionRow(getPool, userId);
  const row = await getSubscriptionRow(getPool, userId);
  if (!row?.stripe_customer_id) {
    return null;
  }
  try {
    await stripe.customers.retrieve(row.stripe_customer_id);
    return row.stripe_customer_id;
  } catch (e) {
    if (!isStripeCustomerMissingError(e)) {
      throw e;
    }
    console.warn(
      '[billing] Clearing stale stripe_customer_id (missing in Stripe)',
      { userId, customerId: row.stripe_customer_id }
    );
    await query(
      getPool,
      `UPDATE subscriptions SET
          stripe_customer_id = NULL,
          stripe_subscription_id = NULL,
          cancel_at_period_end = 0,
          current_period_end = NULL,
          updated_at = NOW()
       WHERE user_id = @user_id`,
      { user_id: userId }
    );
    return null;
  }
}

async function ensureStripeCustomer(stripe, getPool, userId, email) {
  await ensureSubscriptionRow(getPool, userId);
  const row = await getSubscriptionRow(getPool, userId);
  if (row && row.stripe_customer_id) {
    try {
      await stripe.customers.retrieve(row.stripe_customer_id);
      return row.stripe_customer_id;
    } catch (e) {
      if (!isStripeCustomerMissingError(e)) {
        throw e;
      }
      console.warn(
        '[billing] Clearing stale stripe_customer_id (missing in Stripe)',
        { userId, customerId: row.stripe_customer_id }
      );
      await query(
        getPool,
        `UPDATE subscriptions SET
            stripe_customer_id = NULL,
            stripe_subscription_id = NULL,
            cancel_at_period_end = 0,
            current_period_end = NULL,
            updated_at = NOW()
         WHERE user_id = @user_id`,
        { user_id: userId }
      );
    }
  }
  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { userId: String(userId) },
  });
  await query(
    getPool,
    `UPDATE subscriptions SET stripe_customer_id = @stripe_customer_id, updated_at = NOW()
     WHERE user_id = @user_id`,
    { user_id: userId, stripe_customer_id: customer.id }
  );
  return customer.id;
}

async function cancelIncompleteSubscriptionsForCustomer(stripe, customerId) {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'incomplete',
    limit: 20,
  });
  for (const s of subs.data) {
    try {
      await stripe.subscriptions.cancel(s.id);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Block creating a second subscription when Stripe still has a non-terminal subscription
 * (common after cancel-at-period-end DB/Stripe mismatch or past_due).
 */
function assertNoBlockingStripeSubscriptions(subscriptionsList) {
  for (const sub of subscriptionsList) {
    if (!sub || !sub.id) continue;
    if (sub.status === 'past_due') {
      const err = new Error(
        'Your subscription has a past-due payment. Open Account to update your payment method or use Manage billing before subscribing again.'
      );
      err.code = 'STRIPE_SUBSCRIPTION_BLOCKING';
      throw err;
    }
    if (sub.status === 'active' || sub.status === 'trialing') {
      const err = new Error(
        sub.cancel_at_period_end
          ? 'Your membership is still active until the end of the billing period. On the Account page, use “Resume membership” if you canceled by mistake, or wait until access ends before subscribing again.'
          : 'You already have an active membership. Use the Account page to manage your plan.'
      );
      err.code = 'STRIPE_SUBSCRIPTION_BLOCKING';
      throw err;
    }
  }
}

async function listPotentiallyBlockingSubscriptions(stripe, customerId) {
  const out = [];
  for (const status of ['active', 'trialing', 'past_due']) {
    const { data } = await stripe.subscriptions.list({
      customer: customerId,
      status,
      limit: 50,
    });
    out.push(...data);
  }
  return out;
}

async function createSubscriptionPaymentIntentClientSecret(
  stripe,
  getPool,
  userId,
  email,
  priceId,
  promotionCodeId
) {
  const customerId = await ensureStripeCustomer(stripe, getPool, userId, email);
  await cancelIncompleteSubscriptionsForCustomer(stripe, customerId);
  const blocking = await listPotentiallyBlockingSubscriptions(stripe, customerId);
  assertNoBlockingStripeSubscriptions(blocking);
  const params = {
    customer: customerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: { userId: String(userId) },
  };
  if (promotionCodeId) {
    params.discounts = [{ promotion_code: promotionCodeId }];
  }
  const subscription = await stripe.subscriptions.create(params);
  let inv = subscription.latest_invoice;

  if (typeof inv === 'string') {
    inv = await stripe.invoices.retrieve(inv, { expand: ['payment_intent'] });
  } else if (inv && inv.object === 'invoice' && typeof inv.payment_intent === 'string') {
    inv = await stripe.invoices.retrieve(inv.id, { expand: ['payment_intent'] });
  }

  if (inv && inv.status === 'draft') {
    try {
      inv = await stripe.invoices.finalizeInvoice(inv.id, { expand: ['payment_intent'] });
    } catch (finalizeErr) {
      inv = await stripe.invoices.retrieve(inv.id, { expand: ['payment_intent'] });
    }
  }

  let pi = inv && inv.payment_intent;
  if (typeof pi === 'string') {
    pi = await stripe.paymentIntents.retrieve(pi);
  }

  const secret =
    pi && typeof pi === 'object' && pi.client_secret ? pi.client_secret : null;
  if (!secret) {
    console.error('Stripe: subscription missing PaymentIntent client_secret', {
      subscriptionId: subscription.id,
      invoiceId: inv && inv.id,
      invoiceStatus: inv && inv.status,
      amountDue: inv && inv.amount_due,
    });
    const err = new Error('Stripe subscription did not return a payment client secret');
    err.code = 'STRIPE_NO_CLIENT_SECRET';
    throw err;
  }
  return { clientSecret: secret, subscriptionId: subscription.id };
}

module.exports = {
  resolvePriceIdFromRequest,
  getExistingValidStripeCustomerId,
  ensureStripeCustomer,
  createSubscriptionPaymentIntentClientSecret,
  cancelIncompleteSubscriptionsForCustomer,
};
