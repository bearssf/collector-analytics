/**
 * Labels and rows for Account “billing maintenance” #1 — status + period dates from DB.
 */

function formatLongDate(value) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { dateStyle: 'long' });
}

/**
 * Match stored `subscriptions.plan` (first 20 chars of Stripe price id) to Monthly / Yearly / Member.
 */
function resolvePlanLabel(subscriptionRow, priceCfg) {
  if (!subscriptionRow || !subscriptionRow.plan) return null;
  const p = String(subscriptionRow.plan).trim();
  if (!p) return null;
  if (priceCfg.mode === 'dual') {
    if (priceCfg.monthly && priceCfg.monthly.substring(0, 20) === p) return 'Monthly';
    if (priceCfg.yearly && priceCfg.yearly.substring(0, 20) === p) return 'Yearly';
  }
  if (priceCfg.mode === 'legacy' && priceCfg.priceId && priceCfg.priceId.substring(0, 20) === p) {
    return 'Member';
  }
  return null;
}

/**
 * @returns {'month' | 'year' | null}
 */
function resolvePlanInterval(subscriptionRow, priceCfg) {
  const label = resolvePlanLabel(subscriptionRow, priceCfg);
  if (label === 'Monthly') return 'month';
  if (label === 'Yearly') return 'year';
  return null;
}

function statusDisplayLabel(status) {
  switch (status) {
    case 'active':
      return 'Active';
    case 'past_due':
      return 'Past due';
    case 'canceled':
      return 'Canceled';
    case 'trialing':
      return 'Free trial';
    default:
      return status ? String(status) : '—';
  }
}

/**
 * @param {object | null} subscriptionRow — row from `subscriptions`
 * @param {object} priceCfg — from `getStripePriceConfig()`
 * @returns {{ lines: { label: string, value: string }[] }}
 */
function buildBillingSummaryLines(subscriptionRow, priceCfg) {
  if (!subscriptionRow) return { lines: [] };

  const lines = [];
  const status = subscriptionRow.status;
  lines.push({ label: 'Status', value: statusDisplayLabel(status) });

  const plan = resolvePlanLabel(subscriptionRow, priceCfg);
  if (plan) {
    lines.push({ label: 'Plan', value: plan });
  }

  if (status === 'trialing' && subscriptionRow.trial_end) {
    const v = formatLongDate(subscriptionRow.trial_end);
    if (v) lines.push({ label: 'Trial ends', value: v });
  }

  const cancelAtEnd =
    subscriptionRow.cancel_at_period_end === true || subscriptionRow.cancel_at_period_end === 1;
  if (status === 'active' || status === 'past_due') {
    lines.push({
      label: 'Auto-renew',
      value: cancelAtEnd ? 'Off (ends current period)' : 'On',
    });
  }

  const periodEnd = subscriptionRow.current_period_end;
  if (periodEnd && (status === 'active' || status === 'past_due')) {
    const v = formatLongDate(periodEnd);
    if (v) {
      let label = status === 'active' ? 'Next renewal' : 'Current period ends';
      if (status === 'active' && cancelAtEnd) {
        label = 'Membership ends';
      }
      lines.push({ label, value: v });
    }
  } else if (periodEnd && status === 'canceled') {
    const v = formatLongDate(periodEnd);
    if (v) lines.push({ label: 'Billing period reference', value: v });
  }

  return { lines };
}

module.exports = {
  buildBillingSummaryLines,
  resolvePlanLabel,
  resolvePlanInterval,
  formatLongDate,
  statusDisplayLabel,
};
