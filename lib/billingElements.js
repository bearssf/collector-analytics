const { query } = require('./db');
const { ensureSubscriptionRow, getSubscriptionRow } = require('./subscriptions');

function resolvePriceIdFromRequest(intervalQuery, cfg) {
  if (cfg.mode === 'legacy') return cfg.priceId;
  const interval = String(intervalQuery || 'month').toLowerCase();
  if (interval === 'year') return cfg.yearly;
  if (interval === 'month') return cfg.monthly;
  return null;
}

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
  ensureStripeCustomer,
  createSubscriptionPaymentIntentClientSecret,
  cancelIncompleteSubscriptionsForCustomer,
};
