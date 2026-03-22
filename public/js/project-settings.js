(function () {
  const form = document.getElementById('project-settings-form');
  const hidden = document.getElementById('otherSectionsJson');
  const purposeEl = document.getElementById('settings-purpose');
  const purposeOtherWrap = document.getElementById('settings-purpose-other-wrap');
  const sumEl = document.getElementById('settings-other-sum');

  function togglePurposeOther() {
    if (!purposeEl || !purposeOtherWrap) return;
    purposeOtherWrap.hidden = purposeEl.value !== 'Other';
  }

  function updateSum() {
    if (!sumEl) return;
    const rows = document.querySelectorAll('.project-settings-other-row');
    let total = 0;
    rows.forEach(function (row) {
      const p = row.querySelector('.js-section-pct');
      if (!p) return;
      const n = parseInt(p.value, 10);
      if (!Number.isNaN(n)) total += n;
    });
    sumEl.textContent = 'Current total: ' + total + '%' + (total === 100 ? ' ✓' : ' (must be 100%)');
    sumEl.style.color = total === 100 ? 'rgba(160, 220, 180, 0.95)' : 'var(--muted)';
  }

  if (purposeEl) {
    purposeEl.addEventListener('change', togglePurposeOther);
    togglePurposeOther();
  }

  document.querySelectorAll('.js-section-pct').forEach(function (el) {
    el.addEventListener('input', updateSum);
  });
  updateSum();

  if (!form || !hidden) return;

  form.addEventListener('submit', function (e) {
    const rows = document.querySelectorAll('.project-settings-other-row');
    if (rows.length === 0) return;
    const arr = [];
    rows.forEach(function (row) {
      const id = parseInt(row.getAttribute('data-section-id'), 10);
      const title = row.querySelector('.js-section-title').value.trim();
      const progressPercent = parseInt(row.querySelector('.js-section-pct').value, 10);
      arr.push({
        id: id,
        title: title,
        progressPercent: Number.isNaN(progressPercent) ? 0 : progressPercent,
      });
    });
    const sum = arr.reduce(function (a, s) {
      return a + s.progressPercent;
    }, 0);
    if (sum !== 100) {
      e.preventDefault();
      alert('Section percentages must total exactly 100%.');
      return;
    }
    for (var i = 0; i < arr.length; i++) {
      if (!arr[i].title) {
        e.preventDefault();
        alert('Each section needs a name.');
        return;
      }
    }
    hidden.value = JSON.stringify(arr);
  });
})();
