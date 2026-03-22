/**
 * Billing maintenance #5 — change subscription price (e.g. monthly ↔ yearly) with proration.
 */

/**
 * @param {import('stripe').default} stripe
 * @param {string} subscriptionId
 * @param {string} newPriceId
 */
async function changeSubscriptionPlan(stripe, subscriptionId, newPriceId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price'],
  });
  const item = sub.items?.data?.[0];
  if (!item) {
    const err = new Error('No subscription items on subscription.');
    err.code = 'NO_SUBSCRIPTION_ITEMS';
    throw err;
  }
  const currentPriceId = item.price?.id;
  if (currentPriceId === newPriceId) {
    return sub;
  }
  return stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: newPriceId }],
    proration_behavior: 'create_prorations',
  });
}

module.exports = { changeSubscriptionPlan };
