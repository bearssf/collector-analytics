'use strict';

const { formatMoney } = require('./billingPlanPreview');
const { getStripePriceConfig } = require('./billingConfig');

/**
 * Replace env-style placeholders and raw Stripe price IDs with friendly labels.
 * @param {string} raw
 */
function humanizeBillingDescription(raw) {
  if (raw == null || raw === '') return raw;
  let s = String(raw);
  s = s.replace(/\bSTRIPE_PRICE_MONTHLY\b/gi, 'Monthly Subscription');
  s = s.replace(/\bSTRIPE_PRICE_YEARLY\b/gi, 'Yearly Subscription');
  s = s.replace(/\bSTRIPE_PRICE_ID\b/gi, 'Subscription');

  const cfg = getStripePriceConfig();
  if (cfg.mode === 'dual') {
    if (cfg.monthly) s = s.split(cfg.monthly).join('Monthly Subscription');
    if (cfg.yearly) s = s.split(cfg.yearly).join('Yearly Subscription');
  } else if (cfg.mode === 'legacy' && cfg.priceId) {
    s = s.split(cfg.priceId).join('Subscription');
  }
  return s;
}

/**
 * Human-readable description for a paid invoice (no external links).
 * @param {import('stripe').Stripe.Invoice} inv
 */
function invoiceDescription(inv) {
  let out = '';
  const d = inv.description != null ? String(inv.description).trim() : '';
  if (d) {
    out = d;
  } else {
    const lines = inv.lines && inv.lines.data;
    if (Array.isArray(lines) && lines.length) {
      const parts = lines.map((l) => (l.description || '').trim()).filter(Boolean);
      if (parts.length) out = parts.slice(0, 3).join('; ');
    }
    if (!out) {
      out = inv.number ? 'Invoice ' + inv.number : 'Payment';
    }
  }
  return humanizeBillingDescription(out);
}

function paidAtMs(inv) {
  const st = inv.status_transitions;
  if (st && st.paid_at) return Number(st.paid_at) * 1000;
  return Number(inv.created) * 1000;
}

/**
 * Rows for account page table: completed invoice payments only.
 * @param {import('stripe').default} stripe
 * @param {string} customerId
 * @param {number} [limit]
 * @returns {Promise<{ dateLabel: string, amountLabel: string, description: string, statusLabel: string }[]>}
 */
async function fetchBillingHistoryForCustomer(stripe, customerId, limit = 30) {
  if (!stripe || !customerId) return [];
  const cap = Math.min(100, Math.max(1, limit));
  let data;
  try {
    ({ data } = await stripe.invoices.list({
      customer: customerId,
      limit: cap,
      expand: ['data.lines.data'],
    }));
  } catch {
    ({ data } = await stripe.invoices.list({
      customer: customerId,
      limit: cap,
    }));
  }
  const rows = [];
  for (const inv of data) {
    if ((inv.amount_paid || 0) <= 0) continue;
    if (inv.status !== 'paid') continue;
    rows.push({
      dateLabel: new Date(paidAtMs(inv)).toLocaleDateString(undefined, { dateStyle: 'medium' }),
      amountLabel: formatMoney(inv.amount_paid, inv.currency) || '—',
      description: invoiceDescription(inv),
      statusLabel: 'Paid',
    });
  }
  return rows.slice(0, cap);
}

module.exports = { fetchBillingHistoryForCustomer };
