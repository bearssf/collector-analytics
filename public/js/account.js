(function () {
  const profileForm = document.getElementById('account-profile-form');
  const passwordForm = document.getElementById('account-password-form');
  const profileMsg = document.getElementById('account-profile-msg');
  const passwordMsg = document.getElementById('account-password-msg');

  function showMsg(el, text, kind) {
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'account-form-msg';
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = 'account-form-msg account-form-msg--' + (kind || 'ok');
  }

  if (profileForm) {
    profileForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showMsg(profileMsg, '');
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
          return;
        }
        window.location.reload();
      } catch (err) {
        showMsg(profileMsg, 'Network error. Try again.', 'error');
      }
    });
  }

  if (passwordForm) {
    passwordForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      showMsg(passwordMsg, '');
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
          return;
        }
        passwordForm.reset();
        showMsg(passwordMsg, 'Password updated.', 'ok');
      } catch (err) {
        showMsg(passwordMsg, 'Network error. Try again.', 'error');
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

  if (subActions && subMsg) {
    subActions.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.getAttribute('data-action');
      showMsg(subMsg, '');
      if (action === 'cancel-at-period-end') {
        if (
          !window.confirm(
            'Turn off auto-renewal? You keep access until the end of your current billing period.'
          )
        ) {
          return;
        }
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
})();
