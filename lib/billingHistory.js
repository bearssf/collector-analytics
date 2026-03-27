'use strict';

const { formatMoney } = require('./billingPlanPreview');

/**
 * Human-readable description for a paid invoice (no external links).
 * @param {import('stripe').Stripe.Invoice} inv
 */
function invoiceDescription(inv) {
  const d = inv.description != null ? String(inv.description).trim() : '';
  if (d) return d;
  const lines = inv.lines && inv.lines.data;
  if (Array.isArray(lines) && lines.length) {
    const parts = lines.map((l) => (l.description || '').trim()).filter(Boolean);
    if (parts.length) return parts.slice(0, 3).join('; ');
  }
  if (inv.number) return 'Invoice ' + inv.number;
  return 'Payment';
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
