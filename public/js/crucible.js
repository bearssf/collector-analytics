/* ══════════════════════════════════════════════════════════════════════
   The Crucible — source management for AcademiqForge
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var root = document.getElementById('crucible-root');
  if (!root) return;

  var projectId = root.getAttribute('data-project-id');
  var sections = [];
  try {
    sections = JSON.parse(decodeURIComponent(root.getAttribute('data-sections') || '[]'));
  } catch (e) { sections = []; }

  var sources = [];
  var allTags = [];
  var selectedSourceId = null;
  var sortMode = 'alpha';
  var filterTags = [];
  var filterSectionId = null;

  /* ── helpers ─────────────────────────────────────────────────────── */
  function escHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s || ''));
    return d.innerHTML;
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body) opts.body = JSON.stringify(body);
    return fetch('/api/projects/' + projectId + path, opts).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Request failed');
        return d;
      });
    });
  }

  function collectAllTags() {
    var set = {};
    sources.forEach(function (s) {
      (s.tags || []).forEach(function (t) { set[t] = true; });
    });
    allTags = Object.keys(set).sort();
  }

  function getFiltered() {
    var list = sources.slice();
    if (filterTags.length) {
      list = list.filter(function (s) {
        return filterTags.some(function (t) { return (s.tags || []).indexOf(t) !== -1; });
      });
    }
    if (filterSectionId != null) {
      list = list.filter(function (s) {
        return (s.section_ids || []).indexOf(filterSectionId) !== -1;
      });
    }
    if (sortMode === 'date') {
      list.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    } else {
      list.sort(function (a, b) {
        var at = (a.article_title || a.citation_text || '').toLowerCase();
        var bt = (b.article_title || b.citation_text || '').toLowerCase();
        return at < bt ? -1 : at > bt ? 1 : 0;
      });
    }
    return list;
  }

  /* ── render ──────────────────────────────────────────────────────── */
  function render() {
    var filtered = getFiltered();
    var selSrc = selectedSourceId ? sources.find(function (s) { return s.id === selectedSourceId; }) : null;

    var sectionFilterOpts = '<option value="">All sections</option>';
    sections.forEach(function (sec) {
      sectionFilterOpts += '<option value="' + sec.id + '"' + (filterSectionId === sec.id ? ' selected' : '') + '>' + escHtml(sec.title) + '</option>';
    });

    var activeTagCount = filterTags.length ? ' (' + filterTags.length + ')' : '';

    var html = '';

    /* sort / filter bar */
    html += '<div class="crucible-toolbar">' +
      '<div class="crucible-toolbar__left">' +
        '<label class="crucible-sort-label">Sort: ' +
          '<select id="crucible-sort" class="crucible-select">' +
            '<option value="alpha"' + (sortMode === 'alpha' ? ' selected' : '') + '>Alphabetical</option>' +
            '<option value="date"' + (sortMode === 'date' ? ' selected' : '') + '>Date created</option>' +
          '</select>' +
        '</label>' +
        '<button type="button" class="crucible-filter-btn" id="crucible-tag-filter-btn">Filter by tag' + escHtml(activeTagCount) + '</button>' +
        '<label class="crucible-sort-label">Section: ' +
          '<select id="crucible-section-filter" class="crucible-select">' + sectionFilterOpts + '</select>' +
        '</label>' +
      '</div>' +
      '<div class="crucible-toolbar__right">' +
        '<span class="crucible-count">' + filtered.length + ' source' + (filtered.length !== 1 ? 's' : '') + '</span>' +
      '</div>' +
    '</div>';

    /* main area: tiles left, notes right */
    html += '<div class="crucible-main">';

    /* left: tiles */
    html += '<div class="crucible-tiles-pane">';
    if (!filtered.length) {
      html += '<div class="crucible-empty">No sources yet. Click &ldquo;Add a Source&rdquo; below to get started.</div>';
    } else {
      filtered.forEach(function (src) {
        var isActive = selSrc && selSrc.id === src.id;
        var title = src.article_title || src.citation_text || '(Untitled)';
        var authorsLine = src.authors || '';
        var dateLine = src.publication_date || '';
        var journalLine = src.journal_title || '';
        var tagBadges = '';
        (src.tags || []).forEach(function (t) {
          tagBadges += '<span class="crucible-tag-badge">' + escHtml(t) + '</span>';
        });
        html += '<div class="crucible-tile' + (isActive ? ' crucible-tile--active' : '') + '" data-source-id="' + src.id + '">' +
          '<div class="crucible-tile__header">' +
            '<span class="crucible-tile__title">' + escHtml(title) + '</span>' +
            '<span class="crucible-tile__actions">' +
              '<button type="button" class="crucible-tile-btn crucible-tile-btn--edit" data-source-id="' + src.id + '" title="Edit source">&#9998;</button>' +
              '<button type="button" class="crucible-tile-btn crucible-tile-btn--delete" data-source-id="' + src.id + '" title="Delete source">&times;</button>' +
            '</span>' +
          '</div>' +
          (authorsLine ? '<div class="crucible-tile__meta">' + escHtml(authorsLine) + '</div>' : '') +
          '<div class="crucible-tile__meta">' +
            (dateLine ? escHtml(dateLine) : '') +
            (journalLine ? (dateLine ? ' &middot; ' : '') + '<em>' + escHtml(journalLine) + '</em>' : '') +
          '</div>' +
          (tagBadges ? '<div class="crucible-tile__tags">' + tagBadges + '</div>' : '') +
        '</div>';
      });
    }
    html += '</div>';

    /* right: notes */
    html += '<div class="crucible-notes-pane">';
    if (selSrc) {
      html += '<div class="crucible-notes-header">Notes for: <strong>' + escHtml(selSrc.article_title || selSrc.citation_text || '(Untitled)') + '</strong></div>';
      html += '<div id="crucible-notes-editor" class="crucible-notes-editor" contenteditable="true">' + (selSrc.crucible_notes || '') + '</div>';
      html += '<div class="crucible-notes-toolbar">' +
        '<button type="button" class="crucible-notes-fmt-btn" id="crucible-bold-btn" title="Bold"><strong>B</strong></button>' +
        '<button type="button" class="crucible-notes-fmt-btn" id="crucible-ul-btn" title="Bulleted list">&#8226; List</button>' +
        '<button type="button" class="crucible-notes-fmt-btn crucible-notes-save-btn" id="crucible-save-notes-btn">Save notes</button>' +
      '</div>';
    } else {
      html += '<div class="crucible-notes-placeholder">Select a source to view and edit notes.</div>';
    }
    html += '</div>';

    html += '</div>'; // .crucible-main

    /* action bar */
    html += '<div class="crucible-action-bar">' +
      '<button type="button" class="crucible-add-btn" id="crucible-add-source-btn">Add a Source</button>' +
    '</div>';

    root.innerHTML = html;
    bindEvents();
  }

  /* ── event binding ──────────────────────────────────────────────── */
  function bindEvents() {
    var sortSel = document.getElementById('crucible-sort');
    if (sortSel) sortSel.addEventListener('change', function () {
      sortMode = this.value;
      render();
    });

    var secFilter = document.getElementById('crucible-section-filter');
    if (secFilter) secFilter.addEventListener('change', function () {
      filterSectionId = this.value ? parseInt(this.value, 10) : null;
      render();
    });

    var tagFilterBtn = document.getElementById('crucible-tag-filter-btn');
    if (tagFilterBtn) tagFilterBtn.addEventListener('click', function () {
      openTagFilterModal();
    });

    var addBtn = document.getElementById('crucible-add-source-btn');
    if (addBtn) addBtn.addEventListener('click', function () { openSourceModal(null); });

    root.querySelectorAll('.crucible-tile').forEach(function (tile) {
      tile.addEventListener('click', function (e) {
        if (e.target.closest('.crucible-tile-btn')) return;
        selectedSourceId = parseInt(tile.getAttribute('data-source-id'), 10);
        render();
      });
    });

    root.querySelectorAll('.crucible-tile-btn--edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = parseInt(btn.getAttribute('data-source-id'), 10);
        var src = sources.find(function (s) { return s.id === sid; });
        if (src) openSourceModal(src);
      });
    });

    root.querySelectorAll('.crucible-tile-btn--delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = parseInt(btn.getAttribute('data-source-id'), 10);
        if (!confirm('Delete this source? This cannot be undone.')) return;
        api('DELETE', '/sources/' + sid).then(function () {
          sources = sources.filter(function (s) { return s.id !== sid; });
          if (selectedSourceId === sid) selectedSourceId = null;
          collectAllTags();
          render();
        }).catch(function (e) { alert(e.message); });
      });
    });

    var boldBtn = document.getElementById('crucible-bold-btn');
    if (boldBtn) boldBtn.addEventListener('click', function () {
      document.execCommand('bold', false, null);
      document.getElementById('crucible-notes-editor').focus();
    });

    var ulBtn = document.getElementById('crucible-ul-btn');
    if (ulBtn) ulBtn.addEventListener('click', function () {
      document.execCommand('insertUnorderedList', false, null);
      document.getElementById('crucible-notes-editor').focus();
    });

    var saveNotesBtn = document.getElementById('crucible-save-notes-btn');
    if (saveNotesBtn) saveNotesBtn.addEventListener('click', function () {
      if (!selectedSourceId) return;
      var editor = document.getElementById('crucible-notes-editor');
      if (!editor) return;
      var notesHtml = editor.innerHTML;
      api('PATCH', '/sources/' + selectedSourceId, { crucible_notes: notesHtml }).then(function (d) {
        var idx = sources.findIndex(function (s) { return s.id === d.source.id; });
        if (idx !== -1) sources[idx] = d.source;
        saveNotesBtn.textContent = 'Saved!';
        setTimeout(function () { saveNotesBtn.textContent = 'Save notes'; }, 1500);
      }).catch(function (e) { alert(e.message); });
    });
  }

  /* ── tag filter modal ───────────────────────────────────────────── */
  function openTagFilterModal() {
    closeModal();
    if (!allTags.length) { alert('No tags have been created yet.'); return; }

    var overlay = document.createElement('div');
    overlay.className = 'crucible-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'crucible-modal crucible-modal--sm';

    var html = '<div class="crucible-modal__header"><h2>Filter by Tag</h2><button type="button" class="crucible-modal__close" id="crucible-modal-close">&times;</button></div>';
    html += '<div class="crucible-modal__body">';
    html += '<div class="crucible-tag-filter-list">';
    allTags.forEach(function (tag) {
      var checked = filterTags.indexOf(tag) !== -1 ? ' checked' : '';
      html += '<label class="crucible-tag-filter-item"><input type="checkbox" value="' + escHtml(tag) + '"' + checked + '> ' + escHtml(tag) + '</label>';
    });
    html += '</div>';
    html += '</div>';
    html += '<div class="crucible-modal__footer">' +
      '<button type="button" class="crucible-btn crucible-btn--secondary" id="crucible-tag-clear">Clear all</button>' +
      '<button type="button" class="crucible-btn crucible-btn--primary" id="crucible-tag-apply">Apply</button>' +
    '</div>';

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.getElementById('crucible-modal-close').addEventListener('click', closeModal);
    document.getElementById('crucible-tag-clear').addEventListener('click', function () {
      modal.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
    });
    document.getElementById('crucible-tag-apply').addEventListener('click', function () {
      filterTags = [];
      modal.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) {
        filterTags.push(cb.value);
      });
      closeModal();
      render();
    });
  }

  /* ── source add/edit modal ──────────────────────────────────────── */
  function openSourceModal(existing) {
    closeModal();
    var isEdit = !!existing;

    var overlay = document.createElement('div');
    overlay.className = 'crucible-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'crucible-modal';

    var v = existing || {};
    var sectionChecks = '';
    sections.forEach(function (sec) {
      var checked = (v.section_ids || []).indexOf(sec.id) !== -1 ? ' checked' : '';
      sectionChecks += '<label class="crucible-section-check"><input type="checkbox" name="section_ids" value="' + sec.id + '"' + checked + '> ' + escHtml(sec.title) + '</label>';
    });

    var html = '<div class="crucible-modal__header"><h2>' + (isEdit ? 'Edit Source' : 'Add a Source') + '</h2>' +
      '<button type="button" class="crucible-modal__close" id="crucible-modal-close">&times;</button></div>';
    html += '<form id="crucible-source-form" class="crucible-modal__body">';

    html += '<div class="crucible-form-row">' +
      '<label>Authors <span class="crucible-hint">(comma or semicolon separated)</span><input type="text" name="authors" value="' + escHtml(v.authors || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row crucible-form-row--half">' +
      '<label>Publication date<input type="text" name="publication_date" value="' + escHtml(v.publication_date || '') + '" placeholder="e.g. 2024"></label>' +
      '<label>DOI<input type="text" name="doi" value="' + escHtml(v.doi || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row">' +
      '<label>Article title<input type="text" name="article_title" value="' + escHtml(v.article_title || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row">' +
      '<label>Journal / publication title<input type="text" name="journal_title" value="' + escHtml(v.journal_title || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row crucible-form-row--third">' +
      '<label>Volume<input type="text" name="volume_number" value="' + escHtml(v.volume_number || '') + '"></label>' +
      '<label>Issue<input type="text" name="issue_number" value="' + escHtml(v.issue_number || '') + '"></label>' +
      '<label>Page(s)<input type="text" name="page_numbers" value="' + escHtml(v.page_numbers || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row crucible-form-row--half">' +
      '<label>Chapter name <span class="crucible-hint">(if applicable)</span><input type="text" name="chapter_name" value="' + escHtml(v.chapter_name || '') + '"></label>' +
      '<label>Conference name <span class="crucible-hint">(if applicable)</span><input type="text" name="conference_name" value="' + escHtml(v.conference_name || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row">' +
      '<label>Tags <span class="crucible-hint">(comma separated)</span><input type="text" name="tags" value="' + escHtml((v.tags || []).join(', ')) + '"></label>' +
    '</div>';
    if (sections.length) {
      html += '<div class="crucible-form-row"><span class="crucible-field-label">Applicable sections</span><div class="crucible-section-checks">' + sectionChecks + '</div></div>';
    }

    html += '</form>';
    html += '<div class="crucible-modal__footer">' +
      '<button type="button" class="crucible-btn crucible-btn--secondary" id="crucible-modal-cancel">Cancel</button>' +
      '<button type="button" class="crucible-btn crucible-btn--primary" id="crucible-modal-save">' + (isEdit ? 'Save Changes' : 'Add Source') + '</button>' +
    '</div>';

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.getElementById('crucible-modal-close').addEventListener('click', closeModal);
    document.getElementById('crucible-modal-cancel').addEventListener('click', closeModal);
    document.getElementById('crucible-modal-save').addEventListener('click', function () {
      saveSource(isEdit ? existing.id : null);
    });
  }

  function saveSource(existingId) {
    var form = document.getElementById('crucible-source-form');
    if (!form) return;
    var fd = new FormData(form);

    var payload = {
      authors: fd.get('authors') || '',
      publication_date: fd.get('publication_date') || '',
      article_title: fd.get('article_title') || '',
      journal_title: fd.get('journal_title') || '',
      volume_number: fd.get('volume_number') || '',
      issue_number: fd.get('issue_number') || '',
      page_numbers: fd.get('page_numbers') || '',
      doi: fd.get('doi') || '',
      chapter_name: fd.get('chapter_name') || '',
      conference_name: fd.get('conference_name') || '',
      citation_text: fd.get('article_title') || '',
      tags: (fd.get('tags') || '').split(/[,;]/).map(function (t) { return t.trim(); }).filter(Boolean),
      section_ids: fd.getAll('section_ids').map(function (v) { return parseInt(v, 10); }),
    };

    if (!payload.article_title) {
      alert('Article title is required.');
      return;
    }

    var method = existingId ? 'PATCH' : 'POST';
    var path = existingId ? '/sources/' + existingId : '/sources';

    api(method, path, payload).then(function (d) {
      if (existingId) {
        var idx = sources.findIndex(function (s) { return s.id === d.source.id; });
        if (idx !== -1) sources[idx] = d.source;
      } else {
        sources.push(d.source);
        selectedSourceId = d.source.id;
      }
      collectAllTags();
      closeModal();
      render();
    }).catch(function (e) { alert(e.message); });
  }

  /* ── modal close ────────────────────────────────────────────────── */
  function closeModal() {
    var overlay = document.querySelector('.crucible-modal-overlay');
    if (overlay) overlay.remove();
  }

  /* ── init ────────────────────────────────────────────────────────── */
  api('GET', '/sources').then(function (d) {
    sources = d.sources || [];
    collectAllTags();
    render();
  }).catch(function (e) {
    root.innerHTML = '<div class="crucible-empty">Failed to load sources: ' + escHtml(e.message) + '</div>';
  });
})();
