/**
 * Stripe Checkout price configuration.
 * - Dual: STRIPE_PRICE_MONTHLY + STRIPE_PRICE_YEARLY (Account shows two options).
 * - Legacy: STRIPE_PRICE_ID only (single checkout, backward compatible).
 */
function getStripePriceConfig() {
  const monthly = (process.env.STRIPE_PRICE_MONTHLY || '').trim();
  const yearly = (process.env.STRIPE_PRICE_YEARLY || '').trim();
  const legacy = (process.env.STRIPE_PRICE_ID || '').trim();
  if (monthly && yearly) return { mode: 'dual', monthly, yearly };
  if (legacy) return { mode: 'legacy', priceId: legacy };
  return { mode: 'none' };
}

function isStripeBillingConfigured(stripe) {
  return !!(stripe && process.env.PUBLIC_BASE_URL && getStripePriceConfig().mode !== 'none');
}

function billingPriceEnvHint() {
  return 'STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY together, or STRIPE_PRICE_ID alone';
}

module.exports = { getStripePriceConfig, isStripeBillingConfigured, billingPriceEnvHint };
