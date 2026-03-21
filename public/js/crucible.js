/**
 * The Crucible — sources list + link to project sections (GET/POST/PATCH/DELETE /api/...).
 */
(function () {
  const root = document.getElementById('crucible-root');
  if (!root) return;

  const projectId = parseInt(root.dataset.projectId, 10);
  if (Number.isNaN(projectId)) return;

  let sections = [];
  let sources = [];
  let editingId = null;
  let showAdd = false;

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
    if (res.status === 204) return null;
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

  async function load() {
    root.innerHTML = '<p class="crucible-loading">Loading sources…</p>';
    try {
      const bundle = await api('/projects/' + projectId, 'GET');
      const src = await api('/projects/' + projectId + '/sources', 'GET');
      sections = (bundle && bundle.sections) || [];
      sources = (src && src.sources) || [];
      render();
    } catch (e) {
      root.innerHTML =
        '<div class="crucible-error" role="alert">Could not load sources. ' + escapeHtml(e.message) + '</div>';
    }
  }

  function sectionLabel(id) {
    const n = Number(id);
    const s = sections.find(function (x) {
      return Number(x.id) === n;
    });
    return s ? s.title : 'Section #' + id;
  }

  function renderSectionCheckboxes(namePrefix, selectedIds) {
    const sel = new Set(
      (selectedIds || []).map(function (x) {
        return Number(x);
      })
    );
    if (!sections.length) {
      return '<p class="crucible-muted">No sections in this project yet.</p>';
    }
    return (
      '<fieldset class="crucible-fieldset"><legend class="crucible-legend">Link to sections</legend>' +
      sections
        .map(function (sec) {
          const sid = Number(sec.id);
          const checked = sel.has(sid) ? ' checked' : '';
          return (
            '<label class="crucible-check">' +
            '<input type="checkbox" name="' +
            namePrefix +
            '" value="' +
            sid +
            '"' +
            checked +
            ' /> ' +
            escapeHtml(sec.title) +
            '</label>'
          );
        })
        .join('') +
      '</fieldset>'
    );
  }

  function collectSectionIds(container, namePrefix) {
    const boxes = container.querySelectorAll('input[name="' + namePrefix + '"]:checked');
    return Array.prototype.map.call(boxes, function (el) {
      return parseInt(el.value, 10);
    });
  }

  function render() {
    const errSlot = root.querySelector('.crucible-inline-error');
    const errHtml = errSlot ? errSlot.outerHTML : '';

    let html = '<div class="crucible-panel">';
    html += '<div class="crucible-toolbar">';
    html +=
      '<button type="button" class="app-btn-primary crucible-add-btn" id="crucible-toggle-add">' +
      (showAdd ? 'Cancel' : 'Add source') +
      '</button>';
    html += '</div>';

    if (showAdd) {
      html += '<form class="crucible-form" id="crucible-form-add">';
      html += '<label class="crucible-label">Citation <span class="crucible-req">*</span></label>';
      html +=
        '<textarea class="crucible-textarea" name="citationText" rows="4" required placeholder="Full citation or reference text"></textarea>';
      html += '<label class="crucible-label">Notes</label>';
      html += '<textarea class="crucible-textarea" name="notes" rows="2" placeholder="Optional notes"></textarea>';
      html += renderSectionCheckboxes('addSec', []);
      html += '<div class="crucible-form-actions">';
      html += '<button type="submit" class="app-btn-primary">Save source</button>';
      html += '</div>';
      html += '</form>';
    }

    html += errHtml;

    if (!sources.length && !showAdd) {
      html += '<p class="crucible-empty">No sources yet. Add a citation to build your bibliography for this project.</p>';
    }

    html += '<ul class="crucible-list">';
    sources.forEach(function (src) {
      const isEditing = editingId === src.id;
      html += '<li class="crucible-card" data-source-id="' + src.id + '">';
      if (isEditing) {
        html += '<form class="crucible-form crucible-edit-form">';
        html += '<label class="crucible-label">Citation</label>';
        html +=
          '<textarea class="crucible-textarea" name="citationText" rows="4" required>' +
          escapeHtml(src.citation_text) +
          '</textarea>';
        html += '<label class="crucible-label">Notes</label>';
        html +=
          '<textarea class="crucible-textarea" name="notes" rows="2">' +
          escapeHtml(src.notes || '') +
          '</textarea>';
        html += renderSectionCheckboxes('editSec-' + src.id, src.sectionIds);
        html += '<div class="crucible-form-actions">';
        html += '<button type="submit" class="app-btn-primary">Save</button> ';
        html +=
          '<button type="button" class="crucible-btn-secondary crucible-cancel-edit" data-id="' +
          src.id +
          '">Cancel</button>';
        html += '</div>';
        html += '</form>';
      } else {
        html += '<div class="crucible-citation">' + escapeHtml(src.citation_text) + '</div>';
        if (src.notes) {
          html += '<div class="crucible-notes">' + escapeHtml(src.notes) + '</div>';
        }
        const ids = src.sectionIds || [];
        if (ids.length) {
          html += '<div class="crucible-tags">';
          ids.forEach(function (sid) {
            html += '<span class="crucible-tag">' + escapeHtml(sectionLabel(sid)) + '</span>';
          });
          html += '</div>';
        }
        html += '<div class="crucible-card-actions">';
        html +=
          '<button type="button" class="crucible-btn-link crucible-edit" data-id="' +
          src.id +
          '">Edit</button> ';
        html +=
          '<button type="button" class="crucible-btn-link crucible-delete" data-id="' +
          src.id +
          '">Delete</button>';
        html += '</div>';
      }
      html += '</li>';
    });
    html += '</ul></div>';

    root.innerHTML = html;
    bind();
  }

  function showError(msg) {
    const panel = root.querySelector('.crucible-panel');
    if (!panel) return;
    let el = panel.querySelector('.crucible-inline-error');
    if (!el) {
      el = document.createElement('div');
      el.className = 'crucible-inline-error';
      el.setAttribute('role', 'alert');
      const toolbar = panel.querySelector('.crucible-toolbar');
      panel.insertBefore(el, toolbar ? toolbar.nextSibling : panel.firstChild);
    }
    el.textContent = msg;
  }

  function clearError() {
    const el = root.querySelector('.crucible-inline-error');
    if (el) el.remove();
  }

  function bind() {
    const toggle = document.getElementById('crucible-toggle-add');
    if (toggle) {
      toggle.addEventListener('click', function () {
        showAdd = !showAdd;
        editingId = null;
        clearError();
        render();
      });
    }

    const formAdd = document.getElementById('crucible-form-add');
    if (formAdd) {
      formAdd.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        clearError();
        const fd = new FormData(formAdd);
        const citationText = (fd.get('citationText') || '').toString().trim();
        const notes = (fd.get('notes') || '').toString().trim() || null;
        const sectionIds = collectSectionIds(formAdd, 'addSec');
        try {
          await api('/projects/' + projectId + '/sources', 'POST', {
            citationText,
            notes,
            sectionIds,
          });
          showAdd = false;
          await load();
        } catch (e) {
          showError(e.message);
        }
      });
    }

    root.querySelectorAll('.crucible-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingId = parseInt(btn.getAttribute('data-id'), 10);
        showAdd = false;
        clearError();
        render();
      });
    });

    root.querySelectorAll('.crucible-cancel-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingId = null;
        clearError();
        render();
      });
    });

    root.querySelectorAll('.crucible-delete').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const id = parseInt(btn.getAttribute('data-id'), 10);
        if (!confirm('Delete this source?')) return;
        clearError();
        try {
          await api('/sources/' + id, 'DELETE');
          editingId = null;
          await load();
        } catch (e) {
          showError(e.message);
        }
      });
    });

    root.querySelectorAll('.crucible-edit-form').forEach(function (form) {
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        const card = form.closest('.crucible-card');
        const id = card ? parseInt(card.getAttribute('data-source-id'), 10) : NaN;
        if (Number.isNaN(id)) return;
        clearError();
        const fd = new FormData(form);
        const citationText = (fd.get('citationText') || '').toString().trim();
        const notes = (fd.get('notes') || '').toString();
        const sectionIds = collectSectionIds(form, 'editSec-' + id);
        try {
          await api('/sources/' + id, 'PATCH', {
            citationText,
            notes: notes === '' ? null : notes,
            sectionIds,
          });
          editingId = null;
          await load();
        } catch (e) {
          showError(e.message);
        }
      });
    });
  }

  load();
})();
