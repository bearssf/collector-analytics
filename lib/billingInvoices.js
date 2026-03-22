/**
 * Stripe invoice list for Account + GET /api/billing/invoices.
 */

function formatMoneyCents(cents, currency) {
  if (cents == null || currency == null) return '—';
  const n = Number(cents) / 100;
  const cur = String(currency).toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

function statusLabel(status) {
  if (!status) return '—';
  const s = String(status);
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

function stripeInvoicesToDisplayList(stripeInvoiceObjects) {
  return stripeInvoiceObjects.map((inv) => ({
    id: inv.id,
    number: inv.number || inv.id,
    status: inv.status,
    statusLabel: statusLabel(inv.status),
    dateLabel: new Date(inv.created * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }),
    amountLabel: formatMoneyCents(
      inv.total != null ? inv.total : inv.amount_due,
      inv.currency
    ),
    hostedInvoiceUrl: inv.hosted_invoice_url || null,
    invoicePdf: inv.invoice_pdf || null,
  }));
}

/**
 * @param {import('stripe').default} stripe
 */
async function listInvoicesForCustomer(stripe, customerId, limit = 20) {
  const list = await stripe.invoices.list({
    customer: customerId,
    limit,
  });
  return stripeInvoicesToDisplayList(list.data);
}

module.exports = {
  listInvoicesForCustomer,
  stripeInvoicesToDisplayList,
  formatMoneyCents,
  statusLabel,
};
