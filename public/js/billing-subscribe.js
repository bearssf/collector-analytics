(function () {
  const cfg = window.__BILLING_SUBSCRIBE__;
  const form = document.getElementById('billing-subscribe-form');
  const mountEl = document.getElementById('billing-subscribe-payment');
  const errEl = document.getElementById('billing-subscribe-error');
  const submitBtn = document.getElementById('billing-subscribe-submit');

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  }

  if (!cfg || !cfg.publishableKey || !form || !mountEl || typeof Stripe === 'undefined') {
    showError('Billing could not load. Refresh the page or return to Account.');
    return;
  }

  const stripe = Stripe(cfg.publishableKey);
  const base = window.location.origin;

  async function init() {
    const body =
      cfg.priceMode === 'dual' ? { interval: cfg.interval || 'month' } : {};
    const res = await fetch('/api/billing/subscription-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Could not start checkout. Try again from Account.');
      return;
    }
    const clientSecret = data.clientSecret;
    if (!clientSecret) {
      showError('Invalid response from server.');
      return;
    }

    const appearance = {
      theme: 'night',
      variables: { colorPrimary: '#2f80ed' },
    };
    const elements = stripe.elements({ clientSecret, appearance });
    const paymentElement = elements.create('payment');
    paymentElement.mount('#billing-subscribe-payment');
    submitBtn.disabled = false;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      showError('');
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${base}/app/account?subscription=success`,
        },
      });
      if (error) {
        showError(error.message || 'Payment could not be completed.');
        submitBtn.disabled = false;
      }
    });
  }

  init().catch(() => {
    showError('Something went wrong. Try again from Account.');
    submitBtn.disabled = true;
  });
})();
