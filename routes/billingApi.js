const express = require('express');
const {
  isStripeBillingConfigured,
  isStripeElementsBillingConfigured,
  getStripePriceConfig,
} = require('../lib/billingConfig');
const { getSubscriptionRow, appAccessFromRow } = require('../lib/subscriptions');
const { applyStripeSubscriptionObject } = require('../lib/billingStripe');
const {
  resolvePriceIdFromRequest,
  createSubscriptionPaymentIntentClientSecret,
} = require('../lib/billingElements');

/**
 * @param {() => Promise<import('mssql').ConnectionPool>} getPool
 * @param {import('stripe').default | null} stripe
 */
function createBillingApiRouter(getPool, stripe) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  router.post('/subscription-intent', async (req, res, next) => {
    try {
      if (!isStripeElementsBillingConfigured(stripe)) {
        return res.status(503).json({ error: 'On-site billing is not configured (add STRIPE_PUBLISHABLE_KEY).' });
      }
      const userId = req.session.userId;
      const email = req.session.user?.email;
      const row = await getSubscriptionRow(getPool, userId);
      const access = appAccessFromRow(row);
      if (access.paid) {
        return res.status(400).json({ error: 'You already have an active membership.' });
      }
      const cfg = getStripePriceConfig();
      const interval = req.body?.interval;
      const priceId = resolvePriceIdFromRequest(
        cfg.mode === 'dual' ? interval : 'month',
        cfg
      );
      if (!priceId) {
        return res.status(400).json({ error: 'Invalid billing interval or price configuration.' });
      }
      const { clientSecret } = await createSubscriptionPaymentIntentClientSecret(
        stripe,
        getPool,
        userId,
        email,
        priceId
      );
      return res.json({ clientSecret });
    } catch (e) {
      if (e && e.code === 'STRIPE_NO_CLIENT_SECRET') {
        console.error(e.message);
        return res.status(502).json({ error: 'Could not start payment. Try again or contact support.' });
      }
      next(e);
    }
  });

  router.post('/subscription/cancel-at-period-end', async (req, res, next) => {
    try {
      if (!stripe || !isStripeBillingConfigured(stripe)) {
        return res.status(503).json({ error: 'Billing is not configured.' });
      }
      const userId = req.session.userId;
      const row = await getSubscriptionRow(getPool, userId);
      if (!row?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No Stripe subscription on file.' });
      }
      const access = appAccessFromRow(row);
      if (!access.paid && row.status !== 'past_due') {
        return res.status(400).json({ error: 'Subscription cannot be changed in this state.' });
      }
      const sub = await stripe.subscriptions.update(row.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
      await applyStripeSubscriptionObject(getPool, userId, sub);
      res.json({ ok: true });
    } catch (e) {
      if (e.type && String(e.type).startsWith('Stripe')) {
        return res.status(400).json({ error: e.message || 'Stripe could not update the subscription.' });
      }
      next(e);
    }
  });

  router.post('/subscription/resume', async (req, res, next) => {
    try {
      if (!stripe || !isStripeBillingConfigured(stripe)) {
        return res.status(503).json({ error: 'Billing is not configured.' });
      }
      const userId = req.session.userId;
      const row = await getSubscriptionRow(getPool, userId);
      if (!row?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No Stripe subscription on file.' });
      }
      const access = appAccessFromRow(row);
      if (!access.paid && row.status !== 'past_due') {
        return res.status(400).json({ error: 'Subscription cannot be changed in this state.' });
      }
      const sub = await stripe.subscriptions.update(row.stripe_subscription_id, {
        cancel_at_period_end: false,
      });
      await applyStripeSubscriptionObject(getPool, userId, sub);
      res.json({ ok: true });
    } catch (e) {
      if (e.type && String(e.type).startsWith('Stripe')) {
        return res.status(400).json({ error: e.message || 'Stripe could not update the subscription.' });
      }
      next(e);
    }
  });

  return router;
}

module.exports = createBillingApiRouter;
