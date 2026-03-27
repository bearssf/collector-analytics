(function () {
  const cfg = window.__BILLING_SUBSCRIBE__;
  const form = document.getElementById('billing-subscribe-form');
  const mountEl = document.getElementById('billing-subscribe-payment');
  const errEl = document.getElementById('billing-subscribe-error');
  const submitBtn = document.getElementById('billing-subscribe-submit');
  const promoInput = document.getElementById('billing-promo-input');
  const promoApply = document.getElementById('billing-promo-apply');
  const promoHint = document.getElementById('billing-promo-hint');

  let stripe = null;
  let elements = null;
  let paymentElement = null;

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  }

  function showPromoHint(msg) {
    if (!promoHint) return;
    promoHint.textContent = msg || '';
    promoHint.hidden = !msg;
  }

  if (!cfg || !cfg.publishableKey || !form || !mountEl || typeof Stripe === 'undefined') {
    showError('Billing could not load. Refresh the page or return to Account.');
    return;
  }

  stripe = Stripe(cfg.publishableKey);
  const base = window.location.origin;

  function destroyPaymentElement() {
    if (paymentElement) {
      try {
        paymentElement.unmount();
      } catch {
        /* ignore */
      }
      paymentElement = null;
    }
    elements = null;
    if (mountEl) mountEl.innerHTML = '';
  }

  async function fetchIntent(promotionCode) {
    const body =
      cfg.priceMode === 'dual'
        ? { interval: cfg.interval || 'month', promotionCode: promotionCode || undefined }
        : { promotionCode: promotionCode || undefined };
    const res = await fetch('/api/billing/subscription-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Could not start checkout. Try again from Account.');
    }
    if (!data.clientSecret) {
      throw new Error('Invalid response from server.');
    }
    return data.clientSecret;
  }

  function mountPayment(clientSecret) {
    destroyPaymentElement();
    const appearance = {
      theme: 'night',
      variables: { colorPrimary: '#2f80ed' },
    };
    elements = stripe.elements({ clientSecret, appearance });
    paymentElement = elements.create('payment');
    paymentElement.mount('#billing-subscribe-payment');
    submitBtn.disabled = false;
  }

  async function applyPromoAndReload() {
    const code = promoInput ? promoInput.value.trim() : '';
    showError('');
    showPromoHint('');
    submitBtn.disabled = true;
    if (promoApply) promoApply.disabled = true;
    try {
      const clientSecret = await fetchIntent(code || undefined);
      mountPayment(clientSecret);
      if (code) {
        showPromoHint('Promotion applied.');
      }
    } catch (e) {
      showError(e.message || 'Something went wrong.');
      submitBtn.disabled = false;
    } finally {
      if (promoApply) promoApply.disabled = false;
    }
  }

  form.addEventListener('submit', async function (e) {
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
      console.warn(
        '[billing] confirmPayment',
        error.type,
        error.code,
        error.decline_code,
        error.message
      );
      let msg = error.message || 'Payment could not be completed.';
      const lastPi =
        error.payment_intent && error.payment_intent.last_payment_error
          ? error.payment_intent.last_payment_error.message
          : null;
      if (lastPi && String(lastPi).trim()) {
        msg = lastPi;
      }
      const vague = /^a processing error occurred\.?$/i.test(String(msg).trim());
      if (vague) {
        const parts = [];
        if (error.decline_code) {
          parts.push(error.decline_code.replace(/_/g, ' '));
        } else if (error.code) {
          parts.push(error.code);
        }
        msg = parts.length
          ? `Payment failed (${parts.join('; ')}). Try another card or contact your bank.`
          : 'Payment failed. Check the card details, try another card, or confirm your bank allows the charge. If you use test keys, use Stripe test cards (e.g. 4242…).';
      }
      showError(msg);
      submitBtn.disabled = false;
    }
  });

  if (promoApply) {
    promoApply.addEventListener('click', function () {
      applyPromoAndReload();
    });
  }

  async function init() {
    if (cfg.promoPrefill && promoInput) {
      promoInput.value = String(cfg.promoPrefill).trim();
    }
    await applyPromoAndReload();
  }

  init().catch(function () {
    showError('Something went wrong. Try again from Account.');
    submitBtn.disabled = true;
  });
})();
