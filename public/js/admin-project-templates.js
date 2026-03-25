(function () {
  const elJson = document.getElementById('admin-templates-json');
  const root = document.getElementById('admin-root');
  const statusEl = document.getElementById('admin-status');
  const saveBtn = document.getElementById('admin-save');
  const reloadBtn = document.getElementById('admin-reload');
  if (!elJson || !root) return;

  let state = {};
  try {
    state = JSON.parse(elJson.textContent);
  } catch (e) {
    root.innerHTML = '<p class="err">Could not parse template data.</p>';
    return;
  }

  /** Prefer ?token= in URL so secrets with "/" work; else last path segment (legacy). */
  function getAdminToken() {
    try {
      const u = new URL(window.location.href);
      const q = u.searchParams.get('token');
      if (q) return q;
    } catch (e) {
      /* ignore */
    }
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }

  function equalIntegerPercents(n) {
    if (n <= 0) return [];
    const base = Math.floor(100 / n);
    const rem = 100 - base * n;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push(base + (i < rem ? 1 : 0));
    }
    return out;
  }

  function templateKeysSorted(keys) {
    const k = keys.slice();
    k.sort(function (a, b) {
      if (a === 'other') return 1;
      if (b === 'other') return -1;
      return a.localeCompare(b);
    });
    return k;
  }

  function sectionSum(key) {
    const t = state[key];
    if (!t || !t.sections) return 0;
    return t.sections.reduce(function (a, s) {
      const p = parseInt(s && s.percent, 10);
      return a + (Number.isNaN(p) ? 0 : p);
    }, 0);
  }

  function projectedWordsForSection(total, percent) {
    const t = parseInt(total, 10);
    const p = parseInt(percent, 10);
    if (Number.isNaN(t) || t <= 0 || Number.isNaN(p)) return '—';
    return Math.round((t * p) / 100).toLocaleString();
  }

  function render() {
    const keys = templateKeysSorted(Object.keys(state));
    root.innerHTML = '';
    keys.forEach(function (key) {
      const t = state[key];
      if (!t || typeof t !== 'object') return;
      const card = document.createElement('div');
      card.className = 'tpl-card';
      card.dataset.templateKey = key;

      const h = document.createElement('h2');
      h.appendChild(document.createTextNode(key + ' — '));
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = t.label || '';
      labelInput.style.minWidth = '14rem';
      labelInput.addEventListener('input', function () {
        t.label = labelInput.value;
      });
      h.appendChild(labelInput);
      if (t.deprecated) {
        const b = document.createElement('span');
        b.className = 'badge dep';
        b.textContent = 'Deprecated';
        h.appendChild(b);
      }

      card.appendChild(h);

      if (key === 'other') {
        const p = document.createElement('p');
        p.className = 'other-note';
        p.textContent =
          'Custom projects define sections when the user creates the project. No rows here.';
        card.appendChild(p);
        root.appendChild(card);
        return;
      }

      const fields = document.createElement('div');
      fields.className = 'field-row';
      const lab = document.createElement('label');
      lab.textContent = 'Projected total words (whole document)';
      const totalInput = document.createElement('input');
      totalInput.type = 'number';
      totalInput.min = '0';
      totalInput.max = '500000';
      totalInput.className = 'narrow';
      totalInput.value =
        t.projectedTotalWords != null && t.projectedTotalWords !== '' ? String(t.projectedTotalWords) : '';
      totalInput.addEventListener('change', function () {
        const v = totalInput.value.trim();
        t.projectedTotalWords = v === '' ? null : Math.round(Number(v));
        render();
      });
      lab.appendChild(totalInput);
      fields.appendChild(lab);
      card.appendChild(fields);

      const table = document.createElement('table');
      const thead = document.createElement('thead');
      thead.innerHTML =
        '<tr><th>Title</th><th>Slug</th><th>% of doc</th><th>Projected words (this section)</th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      const totalW = t.projectedTotalWords != null ? Number(t.projectedTotalWords) : NaN;

      (t.sections || []).forEach(function (s, idx) {
        const tr = document.createElement('tr');
        const tdTitle = document.createElement('td');
        const inTitle = document.createElement('input');
        inTitle.type = 'text';
        inTitle.value = s.title || '';
        inTitle.addEventListener('input', function () {
          s.title = inTitle.value;
        });
        tdTitle.appendChild(inTitle);

        const tdSlug = document.createElement('td');
        const inSlug = document.createElement('input');
        inSlug.type = 'text';
        inSlug.value = s.slug || '';
        inSlug.addEventListener('input', function () {
          s.slug = inSlug.value;
        });
        tdSlug.appendChild(inSlug);

        const tdPct = document.createElement('td');
        const inPct = document.createElement('input');
        inPct.type = 'number';
        inPct.className = 'pct';
        inPct.min = '0';
        inPct.max = '100';
        inPct.value = s.percent != null ? String(s.percent) : '';
        inPct.addEventListener('change', function () {
          const v = parseInt(inPct.value, 10);
          s.percent = Number.isNaN(v) ? null : v;
          render();
        });
        tdPct.appendChild(inPct);

        const tdProj = document.createElement('td');
        tdProj.textContent = projectedWordsForSection(totalW, s.percent);

        tr.appendChild(tdTitle);
        tr.appendChild(tdSlug);
        tr.appendChild(tdPct);
        tr.appendChild(tdProj);
        tbody.appendChild(tr);
      });

      const sum = sectionSum(key);
      const sumTr = document.createElement('tr');
      sumTr.className = 'sum-row' + (sum !== 100 ? ' bad' : '');
      sumTr.innerHTML =
        '<td colspan="2">Total</td><td>' +
        sum +
        '%</td><td>' +
        (sum === 100 ? 'OK' : 'Must equal 100%') +
        '</td>';
      tbody.appendChild(sumTr);

      table.appendChild(tbody);
      card.appendChild(table);

      const note = document.createElement('p');
      note.className = 'proj-note';
      note.textContent =
        'Estimated completion in the Anvil compares total words across all sections to the projected total above.';
      card.appendChild(note);

      const actions = document.createElement('div');
      actions.className = 'tpl-actions';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = 'Add section';
      addBtn.addEventListener('click', function () {
        t.sections = t.sections || [];
        t.sections.push({ title: 'New section', slug: '', percent: 0 });
        const pcts = equalIntegerPercents(t.sections.length);
        t.sections.forEach(function (sec, i) {
          sec.percent = pcts[i];
        });
        render();
      });
      const remBtn = document.createElement('button');
      remBtn.type = 'button';
      remBtn.textContent = 'Remove last section';
      remBtn.disabled = (t.sections || []).length <= 1;
      remBtn.addEventListener('click', function () {
        if (!t.sections || t.sections.length <= 1) return;
        t.sections.pop();
        const pcts = equalIntegerPercents(t.sections.length);
        t.sections.forEach(function (sec, i) {
          sec.percent = pcts[i];
        });
        render();
      });
      const eqBtn = document.createElement('button');
      eqBtn.type = 'button';
      eqBtn.textContent = 'Even split %';
      eqBtn.addEventListener('click', function () {
        const n = (t.sections || []).length;
        const pcts = equalIntegerPercents(n);
        t.sections.forEach(function (sec, i) {
          sec.percent = pcts[i];
        });
        render();
      });
      actions.appendChild(addBtn);
      actions.appendChild(remBtn);
      actions.appendChild(eqBtn);
      card.appendChild(actions);

      root.appendChild(card);
    });
  }

  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = cls || '';
  }

  saveBtn.addEventListener('click', async function () {
    saveBtn.disabled = true;
    setStatus('Saving…', '');
    const token = getAdminToken();
    try {
      const res = await fetch(
        '/admin/project-templates?token=' + encodeURIComponent(token),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templates: state }),
        }
      );
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setStatus(data.error || 'Save failed', 'err');
        return;
      }
      setStatus('Saved.', 'ok');
    } catch (e) {
      setStatus(e.message || 'Network error', 'err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  reloadBtn.addEventListener('click', function () {
    window.location.reload();
  });

  render();
})();
