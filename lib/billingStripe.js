/**
 * Stripe Checkout + webhook handling. Requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, PUBLIC_BASE_URL.
 */
const {
  ensureSubscriptionRow,
  applyStripeSubscriptionToUser,
  findUserIdByStripeSubscriptionId,
  getSubscriptionRow,
} = require('./subscriptions');

function mapStripeSubscriptionToDbStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
    default:
      return 'canceled';
  }
}

function customerIdString(customer) {
  if (customer == null) return null;
  if (typeof customer === 'string') return customer;
  if (typeof customer === 'object' && customer.id) return customer.id;
  return null;
}

async function applyStripeSubscriptionObject(getPool, userId, stripeSub) {
  const custId = customerIdString(stripeSub.customer);
  const subId = stripeSub.id;
  let dbStatus = mapStripeSubscriptionToDbStatus(stripeSub.status);
  if (stripeSub.status === 'incomplete') {
    const row = await getSubscriptionRow(getPool, userId);
    if (row && row.status === 'trialing') dbStatus = 'trialing';
  }
  const periodEnd = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000)
    : null;
  let planLabel = 'member';
  try {
    const item = stripeSub.items?.data?.[0];
    if (item?.price?.id) planLabel = item.price.id.slice(0, 20);
  } catch {
    /* ignore */
  }
  await applyStripeSubscriptionToUser(getPool, userId, {
    stripeCustomerId: custId,
    stripeSubscriptionId: subId,
    status: dbStatus,
    currentPeriodEnd: periodEnd,
    plan: planLabel,
    cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
  });
}

/**
 * @param {import('stripe').default} stripe
 */
async function handleStripeWebhook(req, res, stripe, getPool) {
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(503).send('Webhook not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (err) {
    console.error('Stripe webhook signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const userId = parseInt(session.client_reference_id || session.metadata?.userId, 10);
        if (Number.isNaN(userId)) {
          console.error('checkout.session.completed: missing client_reference_id / userId');
          break;
        }
        const subId = session.subscription;
        if (!subId) break;
        const stripeSub = await stripe.subscriptions.retrieve(typeof subId === 'string' ? subId : subId.id);
        await applyStripeSubscriptionObject(getPool, userId, stripeSub);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object;
        let userId = parseInt(stripeSub.metadata?.userId, 10);
        if (Number.isNaN(userId)) {
          const found = await findUserIdByStripeSubscriptionId(getPool, stripeSub.id);
          if (found == null) {
            console.error('subscription webhook: unknown subscription', stripeSub.id);
            break;
          }
          userId = found;
        }
        await applyStripeSubscriptionObject(getPool, userId, stripeSub);
        break;
      }
      default:
        break;
    }
    return res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook handler error:', e);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}

module.exports = {
  handleStripeWebhook,
  applyStripeSubscriptionObject,
};
