(function () {
  const profileForm = document.getElementById('account-profile-form');
  const passwordForm = document.getElementById('account-password-form');
  const profileMsg = document.getElementById('account-profile-msg');
  const passwordMsg = document.getElementById('account-password-msg');

  if (document.body.getAttribute('data-subscription-success') === '1') {
    try {
      var u = new URL(window.location.href);
      if (u.searchParams.has('subscription')) {
        u.searchParams.delete('subscription');
        window.history.replaceState({}, '', u.pathname + u.search + u.hash);
      }
    } catch (e) {
      /* ignore */
    }
  }

  const billingPending = document.getElementById('account-billing-pending');
  const pollStatus = document.getElementById('account-billing-poll-status');
  const refreshBtn = document.getElementById('account-billing-refresh-btn');

  async function fetchMePaid() {
    var res = await fetch('/api/me', { credentials: 'same-origin' });
    var data = await res.json().catch(function () {
      return {};
    });
    return !!(data.appAccess && data.appAccess.paid);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      window.location.reload();
    });
  }

  if (billingPending) {
    var attempts = 0;
    var maxAttempts = 24;
    var intervalMs = 2500;
    async function pollTick() {
      attempts += 1;
      if (await fetchMePaid()) {
        window.location.reload();
        return;
      }
      if (pollStatus) {
        pollStatus.hidden = false;
      }
      if (attempts < maxAttempts) {
        setTimeout(pollTick, intervalMs);
      }
    }
    setTimeout(pollTick, 1800);
  }

  document.querySelectorAll('[data-password-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var wrap = btn.closest('.account-password-field__inner');
      var input = wrap && wrap.querySelector('input');
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      var pl = btn.getAttribute('data-password-label') || 'password';
      btn.setAttribute('aria-label', (show ? 'Hide ' : 'Show ') + pl);
      btn.setAttribute('title', show ? 'Hide password' : 'Show password');
    });
  });

  function showMsg(el, text, kind) {
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'account-form-msg';
      el.removeAttribute('aria-busy');
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = 'account-form-msg account-form-msg--' + (kind || 'ok');
    if (kind === 'pending') {
      el.setAttribute('aria-busy', 'true');
    } else {
      el.removeAttribute('aria-busy');
    }
  }

  const profileSubmit = document.getElementById('account-profile-submit');
  const passwordSubmit = document.getElementById('account-password-submit');

  if (profileForm) {
    profileForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showMsg(profileMsg, 'Saving…', 'pending');
      if (profileSubmit) profileSubmit.disabled = true;
      const fd = new FormData(profileForm);
      const body = {
        title: fd.get('title'),
        firstName: (fd.get('firstName') || '').trim(),
        lastName: (fd.get('lastName') || '').trim(),
        university: (fd.get('university') || '').trim(),
        researchFocus: (fd.get('researchFocus') || '').trim(),
        preferredSearchEngine: (fd.get('preferredSearchEngine') || '').trim(),
      };
      try {
        const res = await fetch('/api/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) {
          showMsg(profileMsg, data.error || 'Could not save profile.', 'error');
          if (profileSubmit) profileSubmit.disabled = false;
          return;
        }
        showMsg(profileMsg, 'Profile saved.', 'ok');
        if (profileSubmit) profileSubmit.disabled = false;
      } catch (err) {
        showMsg(profileMsg, 'Network error. Try again.', 'error');
        if (profileSubmit) profileSubmit.disabled = false;
      }
    });
  }

  if (passwordForm) {
    passwordForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showMsg(passwordMsg, 'Saving…', 'pending');
      if (passwordSubmit) passwordSubmit.disabled = true;
      const fd = new FormData(passwordForm);
      const body = {
        currentPassword: fd.get('currentPassword') || '',
        newPassword: fd.get('newPassword') || '',
        confirmPassword: fd.get('confirmPassword') || '',
      };
      try {
        const res = await fetch('/api/me/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) {
          showMsg(passwordMsg, data.error || 'Could not update password.', 'error');
          if (passwordSubmit) passwordSubmit.disabled = false;
          return;
        }
        passwordForm.reset();
        showMsg(passwordMsg, 'Password saved.', 'ok');
        if (passwordSubmit) passwordSubmit.disabled = false;
      } catch (err) {
        showMsg(passwordMsg, 'Network error. Try again.', 'error');
        if (passwordSubmit) passwordSubmit.disabled = false;
      }
    });
  }

  const subActions = document.getElementById('account-subscription-actions');
  const subMsg = document.getElementById('account-subscription-msg');

  async function postBilling(url) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    });
    const data = await res.json().catch(function () {
      return {};
    });
    return { res: res, data: data };
  }

  async function postBillingJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(function () {
      return {};
    });
    return { res: res, data: data };
  }

  const modalCancelRenewal = document.getElementById('account-modal-cancel-renewal');
  const modalCancelRenewalConfirm = document.getElementById('account-modal-cancel-renewal-confirm');
  const modalYearlyPlan = document.getElementById('account-modal-yearly-plan');
  const modalYearlyEstimate = document.getElementById('account-modal-yearly-estimate');
  const modalYearlyConfirm = document.getElementById('account-modal-yearly-confirm');

  let pendingCancelRenewalBtn = null;
  let pendingYearlyPlanBtn = null;

  function openAccountModal(overlay) {
    if (!overlay) return;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeAccountModal(overlay) {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  document.addEventListener('click', function (e) {
    var dismiss = e.target.closest('[data-account-modal-dismiss]');
    if (!dismiss) return;
    var which = dismiss.getAttribute('data-account-modal-dismiss');
    if (which === 'cancel-renewal' && modalCancelRenewal) {
      pendingCancelRenewalBtn = null;
      closeAccountModal(modalCancelRenewal);
    }
    if (which === 'yearly-plan' && modalYearlyPlan) {
      pendingYearlyPlanBtn = null;
      closeAccountModal(modalYearlyPlan);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (modalCancelRenewal && !modalCancelRenewal.hidden) {
      pendingCancelRenewalBtn = null;
      closeAccountModal(modalCancelRenewal);
    }
    if (modalYearlyPlan && !modalYearlyPlan.hidden) {
      pendingYearlyPlanBtn = null;
      closeAccountModal(modalYearlyPlan);
    }
  });

  if (modalCancelRenewalConfirm && modalCancelRenewal) {
    modalCancelRenewalConfirm.addEventListener('click', async function () {
      var btn = pendingCancelRenewalBtn;
      closeAccountModal(modalCancelRenewal);
      pendingCancelRenewalBtn = null;
      if (!btn) return;
      showMsg(subMsg, '');
      btn.disabled = true;
      try {
        const result = await postBilling('/api/billing/subscription/cancel-at-period-end');
        if (!result.res.ok) {
          showMsg(subMsg, result.data.error || 'Could not update subscription.', 'error');
          btn.disabled = false;
          return;
        }
        window.location.reload();
      } catch (err) {
        showMsg(subMsg, 'Network error. Try again.', 'error');
        btn.disabled = false;
      }
    });
  }

  if (subActions && subMsg) {
    subActions.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.getAttribute('data-action');
      showMsg(subMsg, '');
      if (action === 'cancel-at-period-end') {
        pendingCancelRenewalBtn = btn;
        openAccountModal(modalCancelRenewal);
      } else if (action === 'resume-subscription') {
        btn.disabled = true;
        try {
          const result = await postBilling('/api/billing/subscription/resume');
          if (!result.res.ok) {
            showMsg(subMsg, result.data.error || 'Could not update subscription.', 'error');
            btn.disabled = false;
            return;
          }
          window.location.reload();
        } catch (err) {
          showMsg(subMsg, 'Network error. Try again.', 'error');
          btn.disabled = false;
        }
      }
    });
  }

  const planSwitch = document.getElementById('account-plan-switch');
  const planSwitchMsg = document.getElementById('account-plan-switch-msg');

  const planPreviewEstimate = document.getElementById('account-plan-preview-estimate');

  if (planPreviewEstimate) {
    (async function loadPlanPreview() {
      planPreviewEstimate.hidden = true;
      planPreviewEstimate.textContent = 'Loading payment estimate…';
      try {
        const result = await postBillingJson('/api/billing/subscription/plan/preview', {
          interval: 'year',
        });
        if (!result.res.ok || result.data.amountDueFormatted == null) {
          planPreviewEstimate.textContent =
            'We couldn’t load an estimate. Stripe will show the exact amount when you confirm the switch.';
          return;
        }
        var due = result.data.amountDueFormatted;
        planPreviewEstimate.textContent =
          'Estimated charge today if you switch: ' +
            due +
            ' (collected now, not on your next renewal). Taxes may still apply; Stripe sets the final total.';
        planPreviewEstimate.setAttribute('data-amount-due-formatted', due);
      } catch (err) {
        planPreviewEstimate.textContent =
          'We couldn’t load an estimate. Stripe will show the exact amount when you confirm the switch.';
      }
    })();
  }

  async function runPlanSwitch(btn, interval) {
    showMsg(planSwitchMsg, '');
    btn.disabled = true;
    try {
      const result = await postBillingJson('/api/billing/subscription/plan', { interval: interval });
      if (!result.res.ok) {
        showMsg(planSwitchMsg, result.data.error || 'Could not change plan.', 'error');
        btn.disabled = false;
        return;
      }
      window.location.reload();
    } catch (err) {
      showMsg(planSwitchMsg, 'Network error. Try again.', 'error');
      btn.disabled = false;
    }
  }

  if (modalYearlyConfirm && modalYearlyPlan) {
    modalYearlyConfirm.addEventListener('click', async function () {
      var btn = pendingYearlyPlanBtn;
      closeAccountModal(modalYearlyPlan);
      pendingYearlyPlanBtn = null;
      if (!btn) return;
      await runPlanSwitch(btn, 'year');
    });
  }

  if (planSwitch && planSwitchMsg) {
    planSwitch.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-action="switch-plan"]');
      if (!btn || btn.disabled) return;
      const interval = btn.getAttribute('data-interval');
      if (interval !== 'month' && interval !== 'year') return;

      if (interval === 'year') {
        pendingYearlyPlanBtn = btn;
        if (modalYearlyEstimate) {
          var t = planPreviewEstimate && planPreviewEstimate.textContent ? planPreviewEstimate.textContent.trim() : '';
          modalYearlyEstimate.textContent = t;
        }
        openAccountModal(modalYearlyPlan);
        return;
      }

      const label = 'monthly';
      var estimateHint = '';
      if (
        !window.confirm(
          'Switch to ' +
            label +
            ' billing? Proration is usually charged right away (not deferred to your next renewal).' +
            estimateHint
        )
      ) {
        return;
      }
      await runPlanSwitch(btn, 'month');
    });
  }
})();
