(function () {
  const cfg = window.__BILLING_PM__;
  const form = document.getElementById('billing-pm-form');
  const mountEl = document.getElementById('billing-pm-payment');
  const errEl = document.getElementById('billing-pm-error');
  const submitBtn = document.getElementById('billing-pm-submit');

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
    const res = await fetch('/api/billing/setup-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    });
    const data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      showError(data.error || 'Could not start card update. Return to Account.');
      return;
    }
    const clientSecret = data.clientSecret;
    const setupIntentId = data.setupIntentId;
    if (!clientSecret || !setupIntentId) {
      showError('Invalid response from server.');
      return;
    }

    const appearance = {
      theme: 'night',
      variables: { colorPrimary: '#2f80ed' },
    };
    const elements = stripe.elements({ clientSecret: clientSecret, appearance: appearance });
    const paymentElement = elements.create('payment');
    paymentElement.mount('#billing-pm-payment');
    submitBtn.disabled = false;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      submitBtn.disabled = true;
      showError('');
      const returnUrl = base + '/billing/payment-method/return';
      const { error } = await stripe.confirmSetup({
        elements: elements,
        confirmParams: {
          return_url: returnUrl,
        },
      });
      if (error) {
        showError(error.message || 'Could not save card.');
        submitBtn.disabled = false;
        return;
      }

      try {
        const complete = await fetch('/api/billing/setup-intent/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ setupIntentId: setupIntentId }),
        });
        const completeData = await complete.json().catch(function () {
          return {};
        });
        if (!complete.ok) {
          showError(completeData.error || 'Could not save payment method.');
          submitBtn.disabled = false;
          return;
        }
        window.location.href = base + '/app/account?pm=success';
      } catch (err) {
        showError('Something went wrong. Try again from Account.');
        submitBtn.disabled = false;
      }
    });
  }

  init().catch(function () {
    showError('Something went wrong. Try again from Account.');
    submitBtn.disabled = true;
  });
})();
