(function () {
  const I = window.__RA_I18N__ || {};
  const root = document.querySelector('.ra-stage');
  const railAside = document.querySelector('.app-research-anatomy-rail');
  if (!root || !railAside) return;

  const projectId = (function () {
    const m = window.location.pathname.match(/\/app\/project\/(\d+)\//);
    return m ? m[1] : null;
  })();
  if (!projectId) return;

  const LS_KEY = 'af_ra_lock_' + projectId;
  const btn = document.getElementById('ra-initiate-review');
  const statusEl = document.getElementById('ra-review-status');
  const cooldownEl = document.getElementById('ra-cooldown-msg');
  const tbody = document.getElementById('ra-assessment-tbody');
  const tableWrap = document.querySelector('.ra-assessment-table-wrap');
  const emptyEl = document.getElementById('ra-assessment-empty');
  const modalInsufficient = document.getElementById('ra-modal-insufficient');
  const modalTime = document.getElementById('ra-modal-time');

  const minWords = I.minWords != null ? Number(I.minWords) : 100;

  function readLs() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function writeLs(obj) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  function formatCool(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function showModal(el) {
    if (el) el.hidden = false;
  }

  function hideModal(el) {
    if (el) el.hidden = true;
  }

  function setRailSpan(el, active) {
    const span = el.querySelector('[data-rail-span]');
    if (!span) return;
    const full = el.getAttribute('data-span-full') || span.textContent;
    const shortPart = el.getAttribute('data-span-short') || '';
    span.textContent = active && shortPart ? 'Active throughout : ' + shortPart : full;
  }

  function setActive(id, isRail) {
    root.querySelectorAll('.ra-node').forEach(function (el) {
      const nid = el.getAttribute('data-node-id');
      const on = !isRail && nid === id;
      el.classList.toggle('is-active', on);
      const body = el.querySelector('.ra-node__body');
      if (body) body.hidden = !on;
      el.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    root.querySelectorAll('.ra-rail').forEach(function (el) {
      const rid = el.getAttribute('data-rail-id');
      const on = !!isRail && rid === id;
      el.classList.toggle('is-active', on);
      const ex = el.querySelector('.ra-rail__expand');
      if (ex) ex.hidden = !on;
      el.setAttribute('aria-expanded', on ? 'true' : 'false');
      setRailSpan(el, on);
    });
  }

  let activeId = null;
  let activeIsRail = false;

  function toggleNode(id) {
    if (activeId === id && !activeIsRail) {
      activeId = null;
      activeIsRail = false;
      setActive(null, false);
      return;
    }
    activeId = id;
    activeIsRail = false;
    setActive(id, false);
  }

  function toggleRail(id) {
    if (activeId === id && activeIsRail) {
      activeId = null;
      activeIsRail = false;
      setActive(null, false);
      return;
    }
    activeId = id;
    activeIsRail = true;
    setActive(id, true);
  }

  root.querySelectorAll('.ra-node').forEach(function (el) {
    el.addEventListener('click', function () {
      toggleNode(el.getAttribute('data-node-id'));
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleNode(el.getAttribute('data-node-id'));
      }
    });
  });
  root.querySelectorAll('.ra-rail').forEach(function (el) {
    el.addEventListener('click', function () {
      toggleRail(el.getAttribute('data-rail-id'));
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleRail(el.getAttribute('data-rail-id'));
      }
    });
    setRailSpan(el, false);
  });

  if (modalInsufficient) {
    var okIns = document.getElementById('ra-modal-insufficient-ok');
    if (okIns) okIns.addEventListener('click', function () { hideModal(modalInsufficient); });
    modalInsufficient.querySelectorAll('[data-ra-modal-close]').forEach(function (b) {
      b.addEventListener('click', function () { hideModal(modalInsufficient); });
    });
  }
  if (modalTime) {
    var cancelTime = document.getElementById('ra-modal-time-cancel');
    var confirmTime = document.getElementById('ra-modal-time-confirm');
    if (cancelTime)
      cancelTime.addEventListener('click', function () {
        hideModal(modalTime);
      });
    if (confirmTime)
      confirmTime.addEventListener('click', function () {
        hideModal(modalTime);
        executeReview();
      });
    modalTime.querySelectorAll('[data-ra-modal-close]').forEach(function (b) {
      b.addEventListener('click', function () { hideModal(modalTime); });
    });
  }

  function applyResults(results) {
    if (!results || !results.byTile) return;
    const byTile = results.byTile;
    Object.keys(byTile).forEach(function (tileId) {
      const row = byTile[tileId];
      if (!row) return;
      const wrap = root.querySelector('[data-eval-for="' + tileId + '"]');
      if (!wrap) return;
      const scoreEl = wrap.querySelector('[data-part="score"]');
      const fbEl = wrap.querySelector('[data-part="feedback"]');
      if (scoreEl) scoreEl.textContent = row.score || '—';
      if (fbEl) fbEl.textContent = row.feedback || '';
      wrap.hidden = false;
    });

    if (results.tableRows && tbody) {
      tbody.innerHTML = '';
      results.tableRows.forEach(function (tr) {
        const trow = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = tr.component;
        const td2 = document.createElement('td');
        td2.textContent = tr.score || '—';
        trow.appendChild(td1);
        trow.appendChild(td2);
        tbody.appendChild(trow);
      });
      if (tableWrap) tableWrap.classList.add('is-populated');
      if (emptyEl) emptyEl.hidden = true;
    }
  }

  function mergeCooldown(serverUntil) {
    const ls = readLs();
    let until = serverUntil ? new Date(serverUntil) : null;
    if (ls && ls.lockedUntil) {
      const lu = new Date(ls.lockedUntil);
      if (!Number.isNaN(lu.getTime()) && (!until || lu > until)) until = lu;
    }
    return until;
  }

  function updateButtonState(opts) {
    if (!btn) return;
    const hasCompleted = opts.hasCompletedReview;
    if (opts.processing) {
      btn.disabled = true;
      btn.textContent = hasCompleted
        ? I.btnRereview || 'Re-Review My Project'
        : I.btnInitiate || 'Initiate a Review of My Project';
      return;
    }
    const until = mergeCooldown(opts.cooldownUntil);
    const coolActive = until && !Number.isNaN(until.getTime()) && until > new Date();

    btn.textContent = hasCompleted
      ? I.btnRereview || 'Re-Review My Project'
      : I.btnInitiate || 'Initiate a Review of My Project';

    if (coolActive) {
      btn.disabled = true;
      if (cooldownEl) {
        cooldownEl.hidden = false;
        cooldownEl.textContent =
          (I.cooldownPrefix || 'Next review available:') + ' ' + formatCool(until.toISOString());
      }
    } else {
      btn.disabled = false;
      if (cooldownEl) cooldownEl.hidden = true;
    }
  }

  function syncLsFromServer(cooldownUntil, hasCompleted) {
    if (cooldownUntil && hasCompleted) {
      writeLs({ lockedUntil: cooldownUntil, everCompleted: true });
    }
  }

  async function fetchStatus() {
    const res = await fetch('/api/projects/' + projectId + '/research-anatomy/status', {
      credentials: 'same-origin',
    });
    if (!res.ok) return;
    const data = await res.json();
    syncLsFromServer(data.cooldownUntil, data.hasCompletedReview);
    updateButtonState({
      hasCompletedReview: data.hasCompletedReview,
      cooldownUntil: data.cooldownUntil,
      processing: data.latest && data.latest.status === 'processing',
    });
    if (data.results) applyResults(data.results);
    if (data.latest && data.latest.status === 'processing' && statusEl) {
      btn.disabled = true;
      statusEl.hidden = false;
      statusEl.textContent = I.statusProcessing || 'Processing…';
      updateButtonState({
        hasCompletedReview: data.hasCompletedReview,
        cooldownUntil: data.cooldownUntil,
        processing: true,
      });
    }
    if (data.latest && data.latest.status === 'failed' && statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = (I.statusError || 'Error') + ' ' + (data.latest.errorMessage || '');
    }
  }

  async function onReviewButtonClick() {
    if (!btn || btn.disabled) return;

    var ex;
    try {
      ex = await fetch('/api/projects/' + projectId + '/research-anatomy/export-text', {
        credentials: 'same-origin',
      });
      if (!ex.ok) return;
    } catch (e) {
      return;
    }

    var payload = await ex.json();
    var wc = payload.wordCount != null ? Number(payload.wordCount) : 0;
    if (wc < minWords) {
      showModal(modalInsufficient);
      return;
    }

    showModal(modalTime);
  }

  async function executeReview() {
    if (!btn) return;
    btn.disabled = true;
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = I.statusProcessing || 'Processing…';
    }
    if (cooldownEl) cooldownEl.hidden = true;

    var s3Key = null;
    try {
      var ex = await fetch('/api/projects/' + projectId + '/research-anatomy/export-text', {
        credentials: 'same-origin',
      });
      if (!ex.ok) throw new Error('export');
      var payload = await ex.json();
      var text = payload.text || '';

      var pres = await fetch('/api/projects/' + projectId + '/research-anatomy/presign', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (pres.ok) {
        var p = await pres.json();
        if (p.uploadUrl && p.key) {
          var put = await fetch(p.uploadUrl, {
            method: 'PUT',
            body: new Blob([text], { type: 'text/plain;charset=utf-8' }),
            headers: { 'Content-Type': p.contentType || 'text/plain; charset=utf-8' },
          });
          if (!put.ok) throw new Error('s3');
          s3Key = p.key;
        }
      }

      var run = await fetch('/api/projects/' + projectId + '/research-anatomy/run', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3Key: s3Key }),
      });

      if (run.status === 400) {
        var err400 = await run.json().catch(function () { return {}; });
        if (err400.error === 'insufficient_words') {
          showModal(modalInsufficient);
          await fetchStatus();
          if (statusEl) statusEl.hidden = true;
          return;
        }
        throw new Error('run');
      }

      if (run.status === 429) {
        var err429 = await run.json().catch(function () { return {}; });
        if (err429.cooldownUntil)
          writeLs({ lockedUntil: err429.cooldownUntil, everCompleted: true });
        await fetchStatus();
        if (statusEl) statusEl.hidden = true;
        return;
      }

      if (run.status === 503) {
        var err503 = await run.json().catch(function () { return {}; });
        if (err503.error === 'bedrock_not_configured' && statusEl) {
          statusEl.hidden = false;
          statusEl.textContent = I.bedrockMissing || 'AI not configured.';
        }
        btn.disabled = false;
        return;
      }

      if (!run.ok) throw new Error('run');

      var tries = 0;
      var poll = setInterval(async function () {
        tries += 1;
        var st = await fetch('/api/projects/' + projectId + '/research-anatomy/status', {
          credentials: 'same-origin',
        });
        if (!st.ok) return;
        var data = await st.json();
        if (data.latest && data.latest.status === 'complete' && data.results) {
          clearInterval(poll);
          applyResults(data.results);
          if (data.cooldownUntil)
            writeLs({ lockedUntil: data.cooldownUntil, everCompleted: true });
          await fetchStatus();
          if (statusEl) statusEl.hidden = true;
        } else if (data.latest && data.latest.status === 'failed') {
          clearInterval(poll);
          if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = (I.statusError || '') + ' ' + (data.latest.errorMessage || '');
          }
          btn.disabled = false;
        } else if (tries > 200) {
          clearInterval(poll);
          btn.disabled = false;
          if (statusEl) statusEl.hidden = true;
        }
      }, 3000);
    } catch (e) {
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = I.statusError || 'Failed.';
      }
      btn.disabled = false;
    }
  }

  if (btn) btn.addEventListener('click', onReviewButtonClick);
  fetchStatus();
})();
