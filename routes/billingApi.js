const express = require('express');
const { isStripeElementsBillingConfigured, getStripePriceConfig } = require('../lib/billingConfig');
const { getSubscriptionRow, appAccessFromRow } = require('../lib/subscriptions');
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

  return router;
}

module.exports = createBillingApiRouter;
