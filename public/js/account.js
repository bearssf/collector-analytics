(function () {
  function A(key, fallback) {
    var a = window.__I18N__ && window.__I18N__.account;
    return (a && a[key]) || fallback;
  }

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

  function pwdKindLabel(kind) {
    if (kind === 'new') return A('pwdKindNew', 'new password');
    if (kind === 'confirm') return A('pwdKindConfirm', 'confirm new password');
    return A('pwdKindCurrent', 'current password');
  }

  document.querySelectorAll('[data-password-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var wrap = btn.closest('.account-password-field__inner');
      var input = wrap && wrap.querySelector('input');
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      var kind = btn.getAttribute('data-pwd-kind') || 'current';
      var field = pwdKindLabel(kind);
      var hideW = A('hidePassword', 'Hide password');
      var showW = A('showPassword', 'Show password');
      btn.setAttribute('aria-label', (show ? hideW : showW) + ' ' + field);
      btn.setAttribute('title', show ? hideW : showW);
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
      showMsg(profileMsg, A('saving', 'Saving…'), 'pending');
      if (profileSubmit) profileSubmit.disabled = true;
      const fd = new FormData(profileForm);
      const body = {
        title: fd.get('title'),
        firstName: (fd.get('firstName') || '').trim(),
        lastName: (fd.get('lastName') || '').trim(),
        university: (fd.get('university') || '').trim(),
        researchFocus: (fd.get('researchFocus') || '').trim(),
        preferredSearchEngine: (fd.get('preferredSearchEngine') || '').trim(),
        preferredLocale: (fd.get('preferredLocale') || '').trim(),
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
          showMsg(profileMsg, data.error || A('couldNotSaveProfile', 'Could not save profile.'), 'error');
          if (profileSubmit) profileSubmit.disabled = false;
          return;
        }
        showMsg(profileMsg, A('profileSaved', 'Profile saved.'), 'ok');
        if (profileSubmit) profileSubmit.disabled = false;
      } catch (err) {
        showMsg(profileMsg, A('networkError', 'Network error. Try again.'), 'error');
        if (profileSubmit) profileSubmit.disabled = false;
      }
    });
  }

  if (passwordForm) {
    passwordForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var cur = passwordForm.querySelector('[name="currentPassword"]');
      var nw = passwordForm.querySelector('[name="newPassword"]');
      var cf = passwordForm.querySelector('[name="confirmPassword"]');
      function clearValidity() {
        if (cur) cur.setCustomValidity('');
        if (nw) nw.setCustomValidity('');
        if (cf) cf.setCustomValidity('');
      }
      clearValidity();
      var reqMsg = A('fillFieldRequired', 'Please fill out this field.');
      if (!cur || !(cur.value || '').trim()) {
        if (cur) {
          cur.setCustomValidity(reqMsg);
          cur.reportValidity();
        }
        return;
      }
      if (!nw || !(nw.value || '').trim()) {
        if (nw) {
          nw.setCustomValidity(reqMsg);
          nw.reportValidity();
        }
        return;
      }
      if (!cf || !(cf.value || '').trim()) {
        if (cf) {
          cf.setCustomValidity(reqMsg);
          cf.reportValidity();
        }
        return;
      }
      var minMsg = A('passwordMinLengthClient', 'Password must be at least 8 characters.');
      if ((nw.value || '').length < 8) {
        nw.setCustomValidity(minMsg);
        nw.reportValidity();
        return;
      }
      if ((cf.value || '').length < 8) {
        cf.setCustomValidity(minMsg);
        cf.reportValidity();
        return;
      }
      var misMsg = A('passwordMismatchClient', 'New password and confirmation do not match.');
      if (nw.value !== cf.value) {
        cf.setCustomValidity(misMsg);
        cf.reportValidity();
        return;
      }
      showMsg(passwordMsg, A('saving', 'Saving…'), 'pending');
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
          showMsg(passwordMsg, data.error || A('couldNotUpdatePassword', 'Could not update password.'), 'error');
          if (passwordSubmit) passwordSubmit.disabled = false;
          return;
        }
        passwordForm.reset();
        showMsg(passwordMsg, A('passwordSaved', 'Password updated.'), 'ok');
        if (passwordSubmit) passwordSubmit.disabled = false;
      } catch (err) {
        showMsg(passwordMsg, A('networkError', 'Network error. Try again.'), 'error');
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
  const modalBillingHistory = document.getElementById('account-modal-billing-history');
  const openBillingHistoryBtn = document.getElementById('account-open-billing-history');
  const modalYearlyPlan = document.getElementById('account-modal-yearly-plan');
  const modalYearlyAmount = document.getElementById('account-modal-yearly-amount');
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
    if (which === 'billing-history' && modalBillingHistory) {
      closeAccountModal(modalBillingHistory);
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
    if (modalBillingHistory && !modalBillingHistory.hidden) {
      closeAccountModal(modalBillingHistory);
    }
  });

  if (openBillingHistoryBtn && modalBillingHistory) {
    openBillingHistoryBtn.addEventListener('click', function () {
      openAccountModal(modalBillingHistory);
    });
  }

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
          showMsg(subMsg, result.data.error || A('couldNotUpdateSubscription', 'Could not update subscription.'), 'error');
          btn.disabled = false;
          return;
        }
        window.location.reload();
      } catch (err) {
        showMsg(subMsg, A('networkError', 'Network error. Try again.'), 'error');
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
            showMsg(subMsg, result.data.error || A('couldNotUpdateSubscription', 'Could not update subscription.'), 'error');
            btn.disabled = false;
            return;
          }
          window.location.reload();
        } catch (err) {
          showMsg(subMsg, A('networkError', 'Network error. Try again.'), 'error');
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
      planPreviewEstimate.textContent = A('loadingEstimate', 'Loading payment estimate…');
      try {
        const result = await postBillingJson('/api/billing/subscription/plan/preview', {
          interval: 'year',
        });
        if (!result.res.ok || result.data.amountDueFormatted == null) {
          planPreviewEstimate.textContent = A(
            'estimateFailed',
            'We couldn’t load an estimate. Stripe will show the exact amount when you confirm the switch.'
          );
          return;
        }
        var due = result.data.amountDueFormatted;
        planPreviewEstimate.textContent =
          A('estimatedChargePrefix', 'Estimated charge today if you switch: ') +
          due +
          ' (charged now; estimate only, subject to adjustment and taxes).';
        planPreviewEstimate.setAttribute('data-amount-due-formatted', due);
      } catch (err) {
        planPreviewEstimate.textContent = A(
          'estimateFailed',
          'We couldn’t load an estimate. Stripe will show the exact amount when you confirm the switch.'
        );
      }
    })();
  }

  async function runPlanSwitch(btn, interval) {
    showMsg(planSwitchMsg, '');
    btn.disabled = true;
    try {
      const result = await postBillingJson('/api/billing/subscription/plan', { interval: interval });
      if (!result.res.ok) {
        showMsg(planSwitchMsg, result.data.error || A('couldNotChangePlan', 'Could not change plan.'), 'error');
        btn.disabled = false;
        return;
      }
      window.location.reload();
    } catch (err) {
      showMsg(planSwitchMsg, A('networkError', 'Network error. Try again.'), 'error');
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
        if (modalYearlyAmount) {
          var dueFmt =
            planPreviewEstimate && planPreviewEstimate.getAttribute('data-amount-due-formatted');
          if (dueFmt) {
            modalYearlyAmount.textContent = dueFmt;
          } else {
            var fallback = planPreviewEstimate && planPreviewEstimate.textContent
              ? planPreviewEstimate.textContent.trim()
              : '';
            modalYearlyAmount.textContent = fallback || '—';
          }
        }
        openAccountModal(modalYearlyPlan);
        return;
      }

      if (
        !window.confirm(
          A('switchToPrefix', 'Switch to ') + 'monthly' + A('switchToSuffix', ' billing?')
        )
      ) {
        return;
      }
      await runPlanSwitch(btn, 'month');
    });
  }
})();
