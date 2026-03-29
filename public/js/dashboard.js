(function () {
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  var cfg = window.__DASHBOARD__;
  var cancelTargetId = null;

  function renderActiveProject(pid) {
    if (!cfg || !cfg.projectProgress) return;
    var id = Number(pid);
    var pp = cfg.projectProgress.find(function (p) {
      return Number(p.id) === id;
    });
    var root = document.getElementById('dash-active-visual');
    if (!root || !pp) return;

    root.dataset.projectId = String(pp.id);
    var titleEl = root.querySelector('.dash-visual-card__title');
    if (titleEl) titleEl.textContent = pp.name;

    var fill = root.querySelector('.dash-ring__fill');
    if (fill) {
      var arc = Math.round((326.7 * pp.pct) / 100) + ' 327';
      fill.setAttribute('stroke-dasharray', arc);
    }
    var txt = root.querySelector('.dash-ring__text');
    if (txt) txt.textContent = pp.pct + '%';

    var bars = root.querySelector('#dash-active-section-bars');
    if (bars && pp.sections && pp.sections.length) {
      bars.innerHTML = pp.sections
        .map(function (sec) {
          return (
            '<div class="dash-section-bar">' +
            '<span class="dash-section-bar__label" title="' +
            esc(sec.title) +
            '">' +
            esc(sec.title) +
            '</span>' +
            '<div class="dash-section-bar__track"><div class="dash-section-bar__fill" style="width:' +
            sec.pct +
            '%"></div></div>' +
            '<span class="dash-section-bar__pct">' +
            sec.pct +
            '%</span>' +
            '<span class="dash-section-bar__stats">' +
            (sec.words || 0).toLocaleString() +
            ' w · ' +
            (sec.researchOpen || 0) +
            ' open</span>' +
            '</div>'
          );
        })
        .join('');
    } else if (bars) {
      bars.innerHTML = '';
    }
  }

  var sel = document.getElementById('dash-active-project-select');
  if (sel) {
    sel.addEventListener('change', function () {
      renderActiveProject(sel.value);
    });
  }

  var filterSel = document.getElementById('dash-project-filter');
  var rail = document.getElementById('dash-rail-projects');
  function applyProjectFilter() {
    if (!filterSel || !rail) return;
    var v = filterSel.value;
    rail.querySelectorAll('.dash-rail-project-tile').forEach(function (tile) {
      var cat = tile.getAttribute('data-dash-cat') || 'active';
      var show = false;
      if (v === 'active-completed') show = cat === 'active' || cat === 'completed';
      else if (v === 'active') show = cat === 'active';
      else if (v === 'completed') show = cat === 'completed';
      else if (v === 'canceled') show = cat === 'canceled';
      tile.hidden = !show;
    });
  }
  if (filterSel) {
    filterSel.addEventListener('change', applyProjectFilter);
    applyProjectFilter();
  }

  function openModal(el) {
    if (el) el.hidden = false;
  }
  function closeModal(el) {
    if (el) el.hidden = true;
  }

  document.querySelectorAll('.dash-modal-backdrop, .dash-modal-close').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var m = btn.closest('.account-modal-overlay');
      if (m && m.id === 'dash-modal-cancel-project') {
        var c = document.getElementById('dash-cancel-project-confirm');
        if (c) c.disabled = false;
        cancelTargetId = null;
      }
      closeModal(m);
    });
  });

  var researchModal = document.getElementById('dash-modal-research');
  var publishedModal = document.getElementById('dash-modal-published');
  var cancelModal = document.getElementById('dash-modal-cancel-project');

  var openResearch = document.getElementById('dash-open-research-modal');
  if (openResearch && researchModal) {
    openResearch.addEventListener('click', function () {
      openModal(researchModal);
    });
  }
  var openPublished = document.getElementById('dash-open-published-modal');
  if (openPublished && publishedModal) {
    openPublished.addEventListener('click', function () {
      openModal(publishedModal);
    });
  }

  var researchForm = document.getElementById('dash-form-research');
  var researchMsg = document.getElementById('dash-research-form-msg');
  if (researchForm) {
    researchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (researchMsg) {
        researchMsg.hidden = true;
        researchMsg.textContent = '';
      }
      var fd = new FormData(researchForm);
      fetch('/api/me/research-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          researchTopic: fd.get('researchTopic'),
          keywords: fd.get('keywords'),
          notes: fd.get('notes'),
        }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) throw new Error(data.error || 'Could not save.');
            return data;
          });
        })
        .then(function () {
          researchForm.reset();
          closeModal(researchModal);
        })
        .catch(function (err) {
          if (researchMsg) {
            researchMsg.textContent = err.message || 'Error';
            researchMsg.hidden = false;
          }
        });
    });
  }

  var publishedForm = document.getElementById('dash-form-published');
  var publishedMsg = document.getElementById('dash-published-form-msg');
  if (publishedForm) {
    publishedForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (publishedMsg) {
        publishedMsg.hidden = true;
        publishedMsg.textContent = '';
      }
      var fd = new FormData(publishedForm);
      fetch('/api/me/published-work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          title: fd.get('title'),
          datePublished: fd.get('datePublished'),
          wherePublished: fd.get('wherePublished'),
          link: fd.get('link'),
        }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) throw new Error(data.error || 'Could not save.');
            return data;
          });
        })
        .then(function () {
          publishedForm.reset();
          closeModal(publishedModal);
        })
        .catch(function (err) {
          if (publishedMsg) {
            publishedMsg.textContent = err.message || 'Error';
            publishedMsg.hidden = false;
          }
        });
    });
  }

  var dismissCancel = document.getElementById('dash-cancel-project-dismiss');
  var confirmCancel = document.getElementById('dash-cancel-project-confirm');

  document.querySelectorAll('.dash-rail-tile-cancel').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = btn.getAttribute('data-project-id');
      cancelTargetId = id ? parseInt(id, 10) : null;
      if (confirmCancel) confirmCancel.disabled = false;
      openModal(cancelModal);
    });
  });

  if (dismissCancel) {
    dismissCancel.addEventListener('click', function () {
      cancelTargetId = null;
      if (confirmCancel) confirmCancel.disabled = false;
      closeModal(cancelModal);
    });
  }
  if (confirmCancel) {
    confirmCancel.addEventListener('click', function () {
      if (cancelTargetId == null || Number.isNaN(cancelTargetId)) {
        closeModal(cancelModal);
        return;
      }
      confirmCancel.disabled = true;
      fetch('/api/projects/' + encodeURIComponent(cancelTargetId) + '/cancel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) throw new Error(data.error || 'Could not cancel project.');
            return data;
          });
        })
        .then(function () {
          window.location.reload();
        })
        .catch(function (err) {
          window.alert(err.message || 'Could not cancel project.');
          confirmCancel.disabled = false;
        });
    });
  }

  document.querySelectorAll('.app-dashboard-delete').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = btn.getAttribute('data-project-id');
      var raw = btn.getAttribute('data-project-name') || '';
      var name = raw ? decodeURIComponent(raw) : 'this project';
      var msg =
        'Delete “' +
        name +
        '”?\n\nThis permanently removes the project and all of its drafts, sources, and suggestions. This cannot be undone.';
      if (!window.confirm(msg)) return;
      btn.disabled = true;
      fetch('/api/projects/' + encodeURIComponent(id), {
        method: 'DELETE',
        credentials: 'same-origin',
      })
        .then(function (res) {
          if (res.status === 204) {
            window.location.reload();
            return;
          }
          return res.json().then(function (data) {
            throw new Error((data && data.error) || 'Could not delete project.');
          });
        })
        .catch(function (err) {
          window.alert(err.message || 'Could not delete project.');
          btn.disabled = false;
        });
    });
  });
})();
