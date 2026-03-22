const { getSubscriptionRow } = require('./subscriptions');

/**
 * Attach a succeeded SetupIntent’s payment method as default for the customer and subscription.
 * @param {import('stripe').default} stripe
 */
async function applyPaymentMethodFromSetupIntent(stripe, getPool, userId, setupIntentId) {
  const row = await getSubscriptionRow(getPool, userId);
  if (!row?.stripe_customer_id) {
    const err = new Error('No Stripe customer on file.');
    err.code = 'NO_CUSTOMER';
    throw err;
  }

  const si = await stripe.setupIntents.retrieve(setupIntentId);
  const custId = typeof si.customer === 'string' ? si.customer : si.customer?.id;
  if (custId !== row.stripe_customer_id) {
    const err = new Error('Setup intent does not belong to this account.');
    err.code = 'CUSTOMER_MISMATCH';
    throw err;
  }
  if (si.status !== 'succeeded') {
    const err = new Error(`Setup intent status is ${si.status}, not succeeded.`);
    err.code = 'SETUP_NOT_SUCCEEDED';
    throw err;
  }

  const pm = si.payment_method;
  const pmId = typeof pm === 'string' ? pm : pm?.id;
  if (!pmId) {
    const err = new Error('No payment method on setup intent.');
    err.code = 'NO_PAYMENT_METHOD';
    throw err;
  }

  await stripe.customers.update(row.stripe_customer_id, {
    invoice_settings: { default_payment_method: pmId },
  });

  if (row.stripe_subscription_id) {
    try {
      await stripe.subscriptions.update(row.stripe_subscription_id, {
        default_payment_method: pmId,
      });
    } catch (e) {
      console.error('Subscription default_payment_method update:', e.message || e);
    }
  }
}

module.exports = { applyPaymentMethodFromSetupIntent };
