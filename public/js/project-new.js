(function () {
  const form = document.getElementById('project-new-form');
  const purposeEl = document.getElementById('project-purpose');
  const purposeOtherWrap = document.getElementById('project-purpose-other-wrap');
  const templateEl = document.getElementById('project-template-key');
  const otherWrap = document.getElementById('project-other-sections');
  const rowsEl = document.getElementById('project-other-sections-rows');
  const sumEl = document.getElementById('project-other-sum');
  const addBtn = document.getElementById('project-other-add');

  function togglePurposeOther() {
    if (!purposeEl || !purposeOtherWrap) return;
    const show = purposeEl.value === 'Other';
    purposeOtherWrap.hidden = !show;
  }

  function toggleOtherTemplate() {
    if (!templateEl || !otherWrap) return;
    const isOther = templateEl.value === 'other';
    otherWrap.hidden = !isOther;
    if (!isOther && rowsEl) {
      rowsEl.innerHTML = '';
      rowCounter = 0;
    }
    if (isOther && rowsEl && rowsEl.children.length === 0) {
      addRow();
      addRow();
    }
    updateSum();
  }

  function rowHtml(index) {
    return (
      '<div class="project-other-row" data-idx="' +
      index +
      '">' +
      '<label class="app-field project-other-row-title">' +
      '<span>Section name</span>' +
      '<input type="text" name="otherSectionTitle" maxlength="255" required />' +
      '</label>' +
      '<label class="app-field project-other-row-pct">' +
      '<span>% of whole</span>' +
      '<input type="number" name="otherSectionPercent" min="0" max="100" step="1" required />' +
      '</label>' +
      '<button type="button" class="project-other-remove" aria-label="Remove section">×</button>' +
      '</div>'
    );
  }

  let rowCounter = 0;

  function addRow() {
    if (!rowsEl) return;
    if (rowsEl.children.length >= 15) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = rowHtml(rowCounter++);
    const row = wrap.firstElementChild;
    rowsEl.appendChild(row);
    row.querySelector('.project-other-remove').addEventListener('click', function () {
      if (rowsEl.children.length <= 1) return;
      row.remove();
      updateSum();
    });
    row.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', updateSum);
    });
    updateSum();
  }

  function updateSum() {
    if (!sumEl || !rowsEl) return;
    const pcts = rowsEl.querySelectorAll('input[name="otherSectionPercent"]');
    let total = 0;
    pcts.forEach(function (p) {
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
  if (templateEl) {
    templateEl.addEventListener('change', toggleOtherTemplate);
    toggleOtherTemplate();
  }
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      addRow();
    });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      if (templateEl && templateEl.value === 'other') {
        const pcts = rowsEl.querySelectorAll('input[name="otherSectionPercent"]');
        let total = 0;
        pcts.forEach(function (p) {
          const n = parseInt(p.value, 10);
          if (!Number.isNaN(n)) total += n;
        });
        if (total !== 100) {
          e.preventDefault();
          alert('Section percentages must total exactly 100%.');
          return;
        }
        if (rowsEl.children.length < 1 || rowsEl.children.length > 15) {
          e.preventDefault();
          alert('Add between 1 and 15 sections.');
          return;
        }
      }
    });
  }
})();
