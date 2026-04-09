(function () {
  var titleEl = document.getElementById('rs1-title');
  var kwEl = document.getElementById('rs1-keywords');
  var typeEl = document.getElementById('rs1-type');
  var descEl = document.getElementById('rs1-desc');
  var runBtn = document.getElementById('rs1-run');
  var clearBtn = document.getElementById('rs1-clear');
  var statusEl = document.getElementById('rs1-status');
  var outEl = document.getElementById('rs1-out');
  var panelForm = document.getElementById('rs1-panel-form');
  var panelOverlap = document.getElementById('rs1-panel-overlap');
  var panelAdjacent = document.getElementById('rs1-panel-adjacent');
  var panelDone = document.getElementById('rs1-panel-done');
  var overlapListEl = document.getElementById('rs1-overlap-list');
  var overlapDoneBtn = document.getElementById('rs1-overlap-done');
  var adjacentListEl = document.getElementById('rs1-adjacent-list');
  var adjacentErrEl = document.getElementById('rs1-adjacent-error');
  var adjacentCounterEl = document.getElementById('rs1-adjacent-counter');
  var adjacentProceedBtn = document.getElementById('rs1-adjacent-proceed');
  var finalOutEl = document.getElementById('rs1-final-out');
  var startOverBtn = document.getElementById('rs1-start-over');

  var workingPlan = null;
  var overlapQueue = [];

  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = cls || '';
  }

  /** Avoid opaque "Unexpected token '<'" when the server returns an HTML error/login page. */
  function parseFetchJson(r) {
    return r.text().then(function (text) {
      var t = String(text || '').replace(/^\uFEFF/, '').trim();
      if (!t) return {};
      if (t.charAt(0) === '<') {
        throw new Error(
          'Server returned a web page instead of JSON (HTTP ' +
            r.status +
            '). Refresh, sign in again, or check deployment and the /api URL.'
        );
      }
      try {
        return JSON.parse(t);
      } catch (e) {
        throw new Error('Invalid JSON from server (HTTP ' + r.status + '): ' + (e.message || e));
      }
    });
  }

  function parseKeywords(raw) {
    return String(raw || '')
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function uniqMergeArrays(a, b) {
    var seen = {};
    var out = [];
    function add(x) {
      if (x == null || String(x).trim() === '') return;
      var k = String(x).trim().toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(String(x).trim());
    }
    (a || []).forEach(add);
    (b || []).forEach(add);
    return out;
  }

  function applyMerge(plan, overlap) {
    var a = String(overlap.construct_a || '').trim();
    var b = String(overlap.construct_b || '').trim();
    var list = plan.core_constructs || [];
    var ca = list.find(function (c) {
      return String(c.label || '').trim() === a;
    });
    var cb = list.find(function (c) {
      return String(c.label || '').trim() === b;
    });
    if (!ca || !cb) return;
    ca.synonyms = uniqMergeArrays(ca.synonyms, cb.synonyms);
    ca.broader_terms = uniqMergeArrays(ca.broader_terms, cb.broader_terms);
    ca.narrower_terms = uniqMergeArrays(ca.narrower_terms, cb.narrower_terms);
    ca.disciplines = uniqMergeArrays(ca.disciplines, cb.disciplines);
    plan.core_constructs = list.filter(function (c) {
      return String(c.label || '').trim() !== b;
    });
    var rel = plan.construct_relationships || [];
    rel.forEach(function (r) {
      if (String(r.construct_a || '').trim() === b) r.construct_a = a;
      if (String(r.construct_b || '').trim() === b) r.construct_b = a;
    });
    plan.construct_relationships = rel.filter(function (r) {
      return String(r.construct_a || '').trim() !== String(r.construct_b || '').trim();
    });
  }

  function overlapsEqual(x, y) {
    return (
      String(x.construct_a || '').trim() === String(y.construct_a || '').trim() &&
      String(x.construct_b || '').trim() === String(y.construct_b || '').trim()
    );
  }

  function removeOverlapFromQueue(o) {
    overlapQueue = overlapQueue.filter(function (x) {
      return !overlapsEqual(x, o);
    });
    if (workingPlan && Array.isArray(workingPlan.construct_overlap_flags)) {
      workingPlan.construct_overlap_flags = workingPlan.construct_overlap_flags.filter(function (x) {
        return !overlapsEqual(x, o);
      });
    }
  }

  function renderOverlapStep() {
    overlapListEl.innerHTML = '';
    var q = overlapQueue;
    overlapDoneBtn.disabled = q.length > 0;
    q.forEach(function (o) {
      var card = document.createElement('div');
      card.className = 'overlap-card';
      var h = document.createElement('h3');
      h.textContent = String(o.construct_a || '') + ' ↔ ' + String(o.construct_b || '');
      card.appendChild(h);
      var p1 = document.createElement('p');
      p1.innerHTML = '<strong>Overlap</strong> — ' + escapeHtml(String(o.overlap_description || '—'));
      card.appendChild(p1);
      var p2 = document.createElement('p');
      p2.innerHTML =
        '<strong>Recommendation</strong> — ' + escapeHtml(String(o.recommendation || '—'));
      card.appendChild(p2);
      var p3 = document.createElement('p');
      p3.innerHTML = '<strong>Rationale</strong> — ' + escapeHtml(String(o.rationale || '—'));
      card.appendChild(p3);
      var actions = document.createElement('div');
      actions.className = 'actions';
      var btnMerge = document.createElement('button');
      btnMerge.type = 'button';
      btnMerge.textContent = 'Merge';
      btnMerge.addEventListener('click', function () {
        applyMerge(workingPlan, o);
        removeOverlapFromQueue(o);
        renderOverlapStep();
      });
      var btnKeep = document.createElement('button');
      btnKeep.type = 'button';
      btnKeep.className = 'secondary';
      btnKeep.textContent = 'Keep distinct';
      btnKeep.addEventListener('click', function () {
        removeOverlapFromQueue(o);
        renderOverlapStep();
      });
      actions.appendChild(btnMerge);
      actions.appendChild(btnKeep);
      card.appendChild(actions);
      overlapListEl.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showPanels(form, overlap, adjacent, done) {
    panelForm.classList.toggle('rs1-hidden', !form);
    panelOverlap.classList.toggle('rs1-hidden', !overlap);
    panelAdjacent.classList.toggle('rs1-hidden', !adjacent);
    panelDone.classList.toggle('rs1-hidden', !done);
  }

  function goToAdjacentStep() {
    var fields = (workingPlan && workingPlan.adjacent_fields) || [];
    adjacentListEl.innerHTML = '';
    adjacentErrEl.classList.add('rs1-hidden');
    adjacentErrEl.textContent = '';

    if (fields.length < 3) {
      adjacentErrEl.textContent =
        'The model returned fewer than 3 adjacent fields (' +
        fields.length +
        '). Add context and rerun, or adjust the topic.';
      adjacentErrEl.classList.remove('rs1-hidden');
      adjacentProceedBtn.disabled = true;
      adjacentCounterEl.textContent = 'Selected: 0 of 3 (need ≥3 fields from model)';
      showPanels(true, false, true, false);
      return;
    }

    showPanels(false, false, true, false);

    var checkboxes = [];
    fields.forEach(function (af, idx) {
      var lab = document.createElement('label');
      lab.className = 'adj-item';
      lab.style.cursor = 'pointer';
      lab.style.display = 'flex';
      lab.style.gap = '0.65rem';
      lab.style.alignItems = 'flex-start';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      if (fields.length === 3) {
        cb.checked = true;
      }
      checkboxes.push(cb);
      var name = af.field != null ? String(af.field) : '(unnamed field)';
      var inner = document.createElement('div');
      inner.innerHTML =
        '<strong>' +
        escapeHtml(name) +
        '</strong><div style="color:#8b949e;font-size:0.82rem;margin-top:0.25rem">' +
        escapeHtml(String(af.relevance || '')) +
        '</div><div style="font-size:0.8rem;margin-top:0.2rem;color:#c9d1d9">' +
        escapeHtml((af.bridging_terms || []).join(', ')) +
        '</div>';
      lab.appendChild(cb);
      lab.appendChild(inner);
      adjacentListEl.appendChild(lab);
    });

    function updateAdjCounter() {
      var n = checkboxes.filter(function (c) {
        return c.checked;
      }).length;
      adjacentCounterEl.textContent = 'Selected: ' + n + ' of 3';
      adjacentProceedBtn.disabled = n !== 3;
      checkboxes.forEach(function (cb) {
        if (!cb.checked) {
          cb.disabled = n >= 3;
        } else {
          cb.disabled = false;
        }
      });
    }

    checkboxes.forEach(function (cb) {
      cb.addEventListener('change', function () {
        var n = checkboxes.filter(function (c) {
          return c.checked;
        }).length;
        if (n > 3) {
          cb.checked = false;
        }
        updateAdjCounter();
      });
    });

    updateAdjCounter();

    adjacentProceedBtn.onclick = function () {
      var selected = [];
      checkboxes.forEach(function (cb, i) {
        if (cb.checked) selected.push(fields[i]);
      });
      if (selected.length !== 3) return;
      workingPlan.adjacent_fields = selected;
      if (workingPlan.construct_overlap_flags) workingPlan.construct_overlap_flags = [];
      finalizePlan();
    };
  }

  function finalizePlan() {
    var payload = JSON.parse(JSON.stringify(workingPlan));
    delete payload.construct_overlap_flags;
    payload.project_type = (typeEl && typeEl.value) || 'dissertation';

    fetch('/api/admin/research-stage1-finalize', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: payload, project_type: payload.project_type }),
    })
      .then(function (r) {
        return parseFetchJson(r).then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (ref) {
        if (!ref.ok || !ref.data.ok) {
          setStatus(ref.data.error || 'Could not save final plan', 'err');
          return;
        }
        finalOutEl.textContent = JSON.stringify(payload, null, 2);
        showPanels(false, false, false, true);
        setStatus('Final plan saved.', 'ok');
      })
      .catch(function (e) {
        setStatus(e.message || 'Save failed', 'err');
      });
  }

  overlapDoneBtn.addEventListener('click', function () {
    goToAdjacentStep();
  });

  startOverBtn.addEventListener('click', function () {
    workingPlan = null;
    overlapQueue = [];
    outEl.textContent = '';
    outEl.classList.add('rs1-hidden');
    finalOutEl.textContent = '';
    showPanels(true, false, false, false);
    setStatus('', '');
  });

  runBtn.addEventListener('click', function () {
    var title = (titleEl && titleEl.value) || '';
    var keywords = parseKeywords(kwEl && kwEl.value);
    var projectType = (typeEl && typeEl.value) || 'dissertation';
    var description = (descEl && descEl.value && descEl.value.trim()) || null;

    runBtn.disabled = true;
    setStatus('Calling Bedrock…', '');
    outEl.textContent = '';
    outEl.classList.add('rs1-hidden');

    fetch('/api/admin/research-stage1-decompose', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        keywords: keywords,
        projectType: projectType,
        description: description,
      }),
    })
      .then(function (r) {
        return parseFetchJson(r).then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (ref) {
        var data = ref.data;
        if (!ref.ok) {
          setStatus(data.error || 'Request failed', 'err');
          return;
        }
        if (!data.ok || !data.plan) {
          setStatus(data.error || 'Unexpected response', 'err');
          return;
        }
        var sec = data.durationMs != null ? (Number(data.durationMs) / 1000).toFixed(2) : '?';
        setStatus('Done in ' + sec + ' s.', 'ok');
        workingPlan = JSON.parse(JSON.stringify(data.plan));
        outEl.textContent = JSON.stringify(data.plan, null, 2);
        outEl.classList.remove('rs1-hidden');

        var flags = workingPlan.construct_overlap_flags || [];
        overlapQueue = flags.slice();

        if (overlapQueue.length > 0) {
          panelOverlap.classList.remove('rs1-hidden');
          renderOverlapStep();
          showPanels(false, true, false, false);
        } else {
          goToAdjacentStep();
        }
      })
      .catch(function (e) {
        setStatus(e.message || 'Network error', 'err');
      })
      .then(function () {
        runBtn.disabled = false;
      });
  });

  clearBtn.addEventListener('click', function () {
    outEl.textContent = '';
    outEl.classList.add('rs1-hidden');
    setStatus('', '');
  });
})();
