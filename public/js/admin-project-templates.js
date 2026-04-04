(function () {
  const elJson = document.getElementById('admin-templates-json');
  const root = document.getElementById('admin-root');
  const statusEl = document.getElementById('admin-status');
  const saveBtn = document.getElementById('admin-save');
  const reloadBtn = document.getElementById('admin-reload');
  const addTplBtn = document.getElementById('admin-add-template');
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
      const p = parseFloat(s && s.percent);
      return a + (Number.isNaN(p) ? 0 : p);
    }, 0);
  }

  function projectedWordsForSection(total, percent) {
    const t = parseFloat(total);
    const p = parseFloat(percent);
    if (Number.isNaN(t) || t <= 0 || Number.isNaN(p)) return '—';
    return Math.round((t * p) / 100).toLocaleString();
  }

  function moveSection(t, idx, delta) {
    const arr = t.sections;
    if (!arr || arr.length < 2) return;
    const j = idx + delta;
    if (j < 0 || j >= arr.length) return;
    const tmp = arr[idx];
    arr[idx] = arr[j];
    arr[j] = tmp;
    render();
  }

  function deleteSectionAt(t, idx) {
    if (!t.sections || t.sections.length <= 1) return;
    if (!window.confirm('Delete this section? Percentages will be re-split evenly.')) return;
    t.sections.splice(idx, 1);
    const pcts = equalIntegerPercents(t.sections.length);
    t.sections.forEach(function (sec, i) {
      sec.percent = pcts[i];
    });
    render();
  }

  function reorderSectionByDrag(t, fromIdx, toIdx) {
    const arr = t.sections;
    if (!arr || fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= arr.length || toIdx >= arr.length) {
      return;
    }
    const [item] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, item);
    render();
  }

  function slugifyTemplateKey(raw) {
    if (raw == null) return '';
    return String(raw)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  function render() {
    const keys = templateKeysSorted(Object.keys(state));
    root.innerHTML = '';
    keys.forEach(function (key) {
      const t = state[key];
      if (!t || typeof t !== 'object') return;
      if (t.deprecated) return;
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
      table.className = 'tpl-sections-table';
      const thead = document.createElement('thead');
      thead.innerHTML =
        '<tr><th>Order</th><th></th><th>Title</th><th>Slug</th><th>% of doc</th><th>Words (section)</th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      const totalW = t.projectedTotalWords != null ? Number(t.projectedTotalWords) : NaN;
      const sectionCount = (t.sections || []).length;

      (t.sections || []).forEach(function (s, idx) {
        const tr = document.createElement('tr');
        tr.dataset.sectionIndex = String(idx);

        const tdGrip = document.createElement('td');
        tdGrip.className = 'tpl-drag-handle';
        tdGrip.textContent = '⠿';
        tdGrip.title = 'Drag to reorder';
        tdGrip.setAttribute('aria-grabbed', 'false');
        tdGrip.draggable = true;
        tdGrip.addEventListener('dragstart', function (e) {
          tdGrip.setAttribute('aria-grabbed', 'true');
          tr.dataset.dragging = '1';
          try {
            e.dataTransfer.setData('text/plain', String(idx));
            e.dataTransfer.effectAllowed = 'move';
          } catch (err) {
            /* ignore */
          }
        });
        tdGrip.addEventListener('dragend', function () {
          tdGrip.setAttribute('aria-grabbed', 'false');
          delete tr.dataset.dragging;
          tbody.querySelectorAll('tr.drag-over').forEach(function (r) {
            r.classList.remove('drag-over');
          });
        });
        tr.appendChild(tdGrip);

        tr.addEventListener('dragover', function (e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          tr.classList.add('drag-over');
        });
        tr.addEventListener('dragleave', function () {
          tr.classList.remove('drag-over');
        });
        tr.addEventListener('drop', function (e) {
          e.preventDefault();
          tr.classList.remove('drag-over');
          let from = NaN;
          try {
            from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          } catch (err2) {
            from = NaN;
          }
          if (Number.isNaN(from)) return;
          reorderSectionByDrag(t, from, idx);
        });

        const tdActions = document.createElement('td');
        tdActions.className = 'section-row-actions';
        const btnUp = document.createElement('button');
        btnUp.type = 'button';
        btnUp.textContent = '↑';
        btnUp.title = 'Move section up';
        btnUp.setAttribute('aria-label', 'Move section up');
        btnUp.disabled = idx === 0;
        btnUp.addEventListener('click', function () {
          moveSection(t, idx, -1);
        });
        const btnDown = document.createElement('button');
        btnDown.type = 'button';
        btnDown.textContent = '↓';
        btnDown.title = 'Move section down';
        btnDown.setAttribute('aria-label', 'Move section down');
        btnDown.disabled = idx >= sectionCount - 1;
        btnDown.addEventListener('click', function () {
          moveSection(t, idx, 1);
        });
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'danger';
        btnDel.textContent = 'Delete';
        btnDel.title = 'Delete section';
        btnDel.setAttribute('aria-label', 'Delete section');
        btnDel.disabled = sectionCount <= 1;
        btnDel.addEventListener('click', function () {
          deleteSectionAt(t, idx);
        });
        tdActions.appendChild(btnUp);
        tdActions.appendChild(btnDown);
        tdActions.appendChild(btnDel);
        tr.appendChild(tdActions);

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
        inPct.step = '0.01';
        inPct.value = s.percent != null ? String(s.percent) : '';
        inPct.addEventListener('change', function () {
          const v = parseFloat(inPct.value);
          s.percent = Number.isNaN(v) ? null : Math.round(v * 100) / 100;
          render();
        });
        tdPct.appendChild(inPct);

        const tdProj = document.createElement('td');
        const projWrap = document.createElement('div');
        projWrap.className = 'tpl-proj-words';
        const inWords = document.createElement('input');
        inWords.type = 'number';
        inWords.min = '0';
        inWords.max = '500000';
        inWords.className = 'tpl-proj-words-input';
        inWords.placeholder = 'Auto';
        inWords.setAttribute('aria-label', 'Projected words for this section (optional override)');
        inWords.value =
          s.projectedWords != null && s.projectedWords !== '' ? String(Math.round(Number(s.projectedWords))) : '';
        inWords.addEventListener('change', function () {
          const raw = inWords.value.trim();
          if (raw === '') {
            delete s.projectedWords;
          } else {
            const n = Math.round(Number(raw));
            s.projectedWords = Number.isFinite(n) ? n : null;
          }
          render();
        });
        const hint = document.createElement('div');
        hint.className = 'tpl-proj-hint';
        hint.textContent =
          'From %: ' + projectedWordsForSection(totalW, s.percent);
        projWrap.appendChild(inWords);
        projWrap.appendChild(hint);
        tdProj.appendChild(projWrap);

        tr.appendChild(tdTitle);
        tr.appendChild(tdSlug);
        tr.appendChild(tdPct);
        tr.appendChild(tdProj);
        tbody.appendChild(tr);
      });

      const sum = sectionSum(key);
      const sumRounded = Math.round(sum * 100) / 100;
      const sumOk = Math.abs(sumRounded - 100) < 0.001;
      const sumTr = document.createElement('tr');
      sumTr.className = 'sum-row' + (sumOk ? '' : ' bad');
      sumTr.innerHTML =
        '<td></td><td></td><td colspan="2">Total</td><td>' +
        sumRounded +
        '%</td><td>' +
        (sumOk ? 'OK' : 'Must equal 100%') +
        '</td>';
      tbody.appendChild(sumTr);

      table.appendChild(tbody);
      card.appendChild(table);

      const note = document.createElement('p');
      note.className = 'proj-note';
      note.textContent =
        'Anvil and dashboard use per-section word targets when you enter them; otherwise they use % × projected total. Document completion compares all section words to the projected total above.';
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

  if (addTplBtn) {
    addTplBtn.addEventListener('click', function () {
      const raw = window.prompt(
        'Unique template key (lowercase letters, numbers, hyphens). Example: my-white-paper',
        ''
      );
      if (raw == null) return;
      const key = slugifyTemplateKey(raw);
      if (!key) {
        setStatus('Enter a valid key (letters, numbers, hyphens).', 'err');
        return;
      }
      if (key === 'other') {
        setStatus('The key "other" is reserved for custom projects.', 'err');
        return;
      }
      if (state[key]) {
        setStatus('A template with that key already exists.', 'err');
        return;
      }
      state[key] = {
        label: 'New template',
        sections: [
          { title: 'Introduction', slug: 'introduction', percent: 50 },
          { title: 'Conclusion', slug: 'conclusion', percent: 50 },
        ],
        projectedTotalWords: 8000,
      };
      render();
      setStatus('Template added — edit the label and sections, then save.', 'ok');
      try {
        const cards = root.querySelectorAll('.tpl-card');
        for (let i = 0; i < cards.length; i += 1) {
          if (cards[i].dataset.templateKey === key) {
            cards[i].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            break;
          }
        }
      } catch (e) {
        /* ignore */
      }
    });
  }

  render();
})();
