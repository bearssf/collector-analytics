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

/**
 * Publishable key (pk_...) — same value as in Stripe Dashboard → Developers → API keys.
 * Tries several env names so a key copied from Next/Vite docs or a common typo still works.
 */
function getStripePublishableKey() {
  const names = [
    'STRIPE_PUBLISHABLE_KEY',
    'STRIPE_' + 'PUBLISABLE' + '_KEY', // common typo (publisable) — same pk_ value
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'VITE_STRIPE_PUBLISHABLE_KEY',
    'STRIPE_PUBLIC_KEY',
  ];
  for (const name of names) {
    let v = (process.env[name] || '').trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1).trim();
    }
    if (v.startsWith('pk_')) return v;
  }
  return '';
}

/** On-site Payment Element flow: needs publishable key in addition to Checkout requirements. */
function isStripeElementsBillingConfigured(stripe) {
  const pk = getStripePublishableKey();
  return !!(isStripeBillingConfigured(stripe) && pk);
}

function billingPriceEnvHint() {
  return 'STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY together, or STRIPE_PRICE_ID alone';
}

module.exports = {
  getStripePriceConfig,
  getStripePublishableKey,
  isStripeBillingConfigured,
  isStripeElementsBillingConfigured,
  billingPriceEnvHint,
};
