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
const { resolvePromotionCodeId } = require('../lib/billingPromotion');
const { applyPaymentMethodFromSetupIntent } = require('../lib/billingPaymentMethod');
const { resolvePlanInterval, isWithinDaysBeforePeriodEnd } = require('../lib/billingAccountDisplay');
const { changeSubscriptionPlan } = require('../lib/billingPlanChange');
const {
  previewSubscriptionPlanChange,
  summarizeUpcomingInvoice,
} = require('../lib/billingPlanPreview');

/**
 * @param {() => Promise<import('mysql2/promise').Pool>} getPool
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
      let promotionCodeId = null;
      const rawPromo = req.body?.promotionCode;
      if (rawPromo != null && String(rawPromo).trim() !== '') {
        try {
          promotionCodeId = await resolvePromotionCodeId(stripe, rawPromo);
        } catch (e) {
          if (e && e.code === 'INVALID_PROMOTION_CODE') {
            return res.status(400).json({ error: e.message });
          }
          throw e;
        }
      }
      const { clientSecret } = await createSubscriptionPaymentIntentClientSecret(
        stripe,
        getPool,
        userId,
        email,
        priceId,
        promotionCodeId
      );
      return res.json({ clientSecret });
    } catch (e) {
      if (e && e.code === 'STRIPE_NO_CLIENT_SECRET') {
        console.error(e.message);
        return res.status(502).json({ error: 'Could not start payment. Try again or contact support.' });
      }
      if (e && e.code === 'STRIPE_SUBSCRIPTION_BLOCKING') {
        return res.status(400).json({ error: e.message || 'Subscription cannot be started in the current state.' });
      }
      if (e && e.type && String(e.type).startsWith('Stripe')) {
        console.error('[billing] subscription-intent Stripe:', e.message, e.code, e.param);
        const raw = e.message ? String(e.message).trim() : '';
        const msg =
          raw && raw.length < 280
            ? raw
            : 'Stripe could not start the subscription. Try again or contact support.';
        return res.status(400).json({ error: msg });
      }
      console.error('[billing] subscription-intent:', e && e.message ? e.message : e);
      return res.status(502).json({
        error: 'Could not start checkout. Try again from Account, or contact support if this continues.',
      });
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

  router.post('/setup-intent', async (req, res, next) => {
    try {
      if (!stripe || !isStripeElementsBillingConfigured(stripe)) {
        return res
          .status(503)
          .json({ error: 'On-site card updates require STRIPE_PUBLISHABLE_KEY (pk_...).' });
      }
      const row = await getSubscriptionRow(getPool, req.session.userId);
      if (!row?.stripe_customer_id) {
        return res.status(400).json({ error: 'No Stripe customer. Subscribe or use checkout first.' });
      }
      const setupIntent = await stripe.setupIntents.create({
        customer: row.stripe_customer_id,
        payment_method_types: ['card'],
      });
      if (!setupIntent.client_secret) {
        return res.status(502).json({ error: 'Could not start card update.' });
      }
      return res.json({
        clientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/setup-intent/complete', async (req, res, next) => {
    try {
      if (!stripe || !isStripeElementsBillingConfigured(stripe)) {
        return res.status(503).json({ error: 'Billing is not configured.' });
      }
      const setupIntentId = req.body?.setupIntentId;
      if (!setupIntentId || typeof setupIntentId !== 'string') {
        return res.status(400).json({ error: 'setupIntentId is required.' });
      }
      await applyPaymentMethodFromSetupIntent(stripe, getPool, req.session.userId, setupIntentId);
      res.json({ ok: true });
    } catch (e) {
      if (
        e.code === 'NO_CUSTOMER' ||
        e.code === 'CUSTOMER_MISMATCH' ||
        e.code === 'SETUP_NOT_SUCCEEDED' ||
        e.code === 'NO_PAYMENT_METHOD'
      ) {
        return res.status(400).json({ error: e.message || 'Could not apply payment method.' });
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

  router.post('/subscription/plan/preview', async (req, res, next) => {
    try {
      if (!stripe || !isStripeBillingConfigured(stripe)) {
        return res.status(503).json({ error: 'Billing is not configured.' });
      }
      const cfg = getStripePriceConfig();
      if (cfg.mode !== 'dual') {
        return res
          .status(400)
          .json({ error: 'Plan preview requires monthly and yearly price IDs (dual mode).' });
      }
      const userId = req.session.userId;
      const row = await getSubscriptionRow(getPool, userId);
      if (!row?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No Stripe subscription on file.' });
      }
      const access = appAccessFromRow(row);
      if (!access.paid && row.status !== 'past_due') {
        return res.status(400).json({ error: 'Subscription cannot be previewed in this state.' });
      }
      const interval = String(req.body?.interval || '').toLowerCase();
      if (interval !== 'month' && interval !== 'year') {
        return res.status(400).json({ error: 'Body must include interval: "month" or "year".' });
      }
      const newPriceId = interval === 'year' ? cfg.yearly : cfg.monthly;
      if (!newPriceId) {
        return res.status(400).json({ error: 'Price configuration is incomplete.' });
      }
      const current = resolvePlanInterval(row, cfg);
      if (current !== 'month' && current !== 'year') {
        return res.status(400).json({
          error:
            'Current plan could not be matched to monthly/yearly; use Manage billing or contact support.',
        });
      }
      if (current === interval) {
        return res.status(400).json({ error: 'You are already on this billing interval.' });
      }
      if (current === 'year' && interval === 'month' && !isWithinDaysBeforePeriodEnd(row, 30)) {
        return res.status(400).json({
          error:
            'Switching to monthly billing is only available within 30 days of your renewal date.',
        });
      }
      const invoice = await previewSubscriptionPlanChange(
        stripe,
        row.stripe_subscription_id,
        newPriceId
      );
      res.json(summarizeUpcomingInvoice(invoice));
    } catch (e) {
      if (e.code === 'NO_SUBSCRIPTION_ITEMS' || e.code === 'NO_CUSTOMER') {
        return res.status(400).json({ error: e.message });
      }
      if (e.type && String(e.type).startsWith('Stripe')) {
        return res.status(400).json({ error: e.message || 'Could not preview invoice.' });
      }
      next(e);
    }
  });

  router.post('/subscription/plan', async (req, res, next) => {
    try {
      if (!stripe || !isStripeBillingConfigured(stripe)) {
        return res.status(503).json({ error: 'Billing is not configured.' });
      }
      const cfg = getStripePriceConfig();
      if (cfg.mode !== 'dual') {
        return res
          .status(400)
          .json({ error: 'Plan change requires monthly and yearly price IDs (dual mode).' });
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
      const interval = String(req.body?.interval || '').toLowerCase();
      if (interval !== 'month' && interval !== 'year') {
        return res.status(400).json({ error: 'Body must include interval: "month" or "year".' });
      }
      const newPriceId = interval === 'year' ? cfg.yearly : cfg.monthly;
      if (!newPriceId) {
        return res.status(400).json({ error: 'Price configuration is incomplete.' });
      }
      const current = resolvePlanInterval(row, cfg);
      if (current !== 'month' && current !== 'year') {
        return res.status(400).json({
          error:
            'Current plan could not be matched to monthly/yearly; use Manage billing or contact support.',
        });
      }
      if (current === interval) {
        return res.status(400).json({ error: 'You are already on this billing interval.' });
      }
      if (current === 'year' && interval === 'month' && !isWithinDaysBeforePeriodEnd(row, 30)) {
        return res.status(400).json({
          error:
            'Switching to monthly billing is only available within 30 days of your renewal date. Use Manage billing or contact support.',
        });
      }
      const sub = await changeSubscriptionPlan(stripe, row.stripe_subscription_id, newPriceId);
      await applyStripeSubscriptionObject(getPool, userId, sub);
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'NO_SUBSCRIPTION_ITEMS') {
        return res.status(400).json({ error: e.message });
      }
      if (e.type && String(e.type).startsWith('Stripe')) {
        return res.status(400).json({ error: e.message || 'Stripe could not update the subscription.' });
      }
      next(e);
    }
  });

  return router;
}

module.exports = createBillingApiRouter;
