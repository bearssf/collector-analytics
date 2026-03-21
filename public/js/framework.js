/**
 * Framework — project outline: section status + progress (PATCH /api/projects/:pid/sections/:sid).
 */
(function () {
  const root = document.getElementById('framework-root');
  if (!root) return;

  const projectId = parseInt(root.dataset.projectId, 10);
  if (Number.isNaN(projectId)) return;

  const STATUS_OPTIONS = [
    { value: 'not_started', label: 'Not started' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'review', label: 'In review' },
    { value: 'complete', label: 'Complete' },
  ];

  let bundle = null;
  const debouncers = {};

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function api(path, method, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error('Invalid response from server');
    }
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || 'Request failed';
      throw new Error(msg);
    }
    return data;
  }

  function renderStatusSelect(sectionId, current) {
    const cur = current || 'not_started';
    const hasInList = STATUS_OPTIONS.some(function (o) {
      return o.value === cur;
    });
    let html =
      '<label class="fw-field"><span class="fw-field-label">Status</span><select class="fw-select js-fw-status" data-section-id="' +
      sectionId +
      '" aria-label="Section status">';
    if (!hasInList && cur) {
      html +=
        '<option value="' +
        escapeHtml(cur) +
        '" selected>' +
        escapeHtml(cur) +
        ' (current)</option>';
    }
    STATUS_OPTIONS.forEach(function (opt) {
      const sel = hasInList && opt.value === cur ? ' selected' : '';
      html += '<option value="' + escapeHtml(opt.value) + '"' + sel + '>' + escapeHtml(opt.label) + '</option>';
    });
    html += '</select></label>';
    return html;
  }

  function renderProgress(sectionId, progress) {
    const p = Math.min(100, Math.max(0, parseInt(progress, 10) || 0));
    return (
      '<label class="fw-field fw-field-progress">' +
      '<span class="fw-field-label">Progress <span class="fw-pct js-fw-pct-' +
      sectionId +
      '">' +
      p +
      '%</span></span>' +
      '<input type="range" class="fw-range js-fw-progress" min="0" max="100" step="1" value="' +
      p +
      '" data-section-id="' +
      sectionId +
      '" aria-label="Section progress percent" />' +
      '</label>'
    );
  }

  async function patchSection(sectionId, payload) {
    try {
      bundle = await api('/projects/' + projectId + '/sections/' + sectionId, 'PATCH', payload);
      render();
      setGlobalStatus('Saved', false);
    } catch (e) {
      setGlobalStatus(e.message, true);
    }
  }

  function setGlobalStatus(msg, isErr) {
    const el = document.getElementById('framework-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'fw-global-status' + (isErr ? ' is-error' : '');
  }

  function scheduleProgressSave(sectionId, progressPercent) {
    const key = String(sectionId);
    if (debouncers[key]) clearTimeout(debouncers[key]);
    debouncers[key] = setTimeout(function () {
      debouncers[key] = null;
      patchSection(sectionId, { progressPercent: progressPercent });
    }, 450);
  }

  function render() {
    if (!bundle) return;
    const sections = (bundle.sections || []).slice().sort(function (a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0);
    });

    if (!sections.length) {
      root.innerHTML =
        '<div class="fw-panel"><p class="fw-muted">No sections in this project outline.</p></div>';
      return;
    }

    let html =
      '<div class="fw-panel"><p id="framework-status" class="fw-global-status" aria-live="polite"></p>';
    html += '<ol class="fw-outline">';

    sections.forEach(function (sec) {
      const sid = Number(sec.id);
      const title = sec.title || 'Section';
      const slug = sec.slug ? '<code class="fw-slug">' + escapeHtml(sec.slug) + '</code>' : '';
      html += '<li class="fw-card" data-section-id="' + sid + '">';
      html += '<div class="fw-card-head">';
      html += '<h2 class="fw-title">' + escapeHtml(title) + '</h2>';
      html += slug;
      html += '</div>';
      html += '<div class="fw-card-controls">';
      html += renderStatusSelect(sid, sec.status);
      html += renderProgress(sid, sec.progress_percent);
      html += '</div>';
      html += '</li>';
    });

    html += '</ol></div>';
    root.innerHTML = html;

    root.querySelectorAll('.js-fw-status').forEach(function (sel) {
      sel.addEventListener('change', function () {
        const sid = parseInt(sel.getAttribute('data-section-id'), 10);
        patchSection(sid, { status: sel.value });
      });
    });

    root.querySelectorAll('.js-fw-progress').forEach(function (range) {
      range.addEventListener('input', function () {
        const sid = parseInt(range.getAttribute('data-section-id'), 10);
        const v = parseInt(range.value, 10) || 0;
        const pct = root.querySelector('.js-fw-pct-' + sid);
        if (pct) pct.textContent = v + '%';
        scheduleProgressSave(sid, v);
      });
    });
  }

  async function load() {
    root.innerHTML = '<p class="fw-loading">Loading outline…</p>';
    try {
      bundle = await api('/projects/' + projectId, 'GET');
      render();
    } catch (e) {
      root.innerHTML =
        '<div class="fw-panel"><p class="fw-global-status is-error" role="alert">' +
        escapeHtml(e.message) +
        '</p></div>';
    }
  }

  load();
})();
