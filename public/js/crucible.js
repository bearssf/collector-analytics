/* ══════════════════════════════════════════════════════════════════════
   The Crucible — source management for AcademiqForge
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var root = document.getElementById('crucible-root');
  if (!root) return;

  var projectId = root.getAttribute('data-project-id');
  var citationStyle = root.getAttribute('data-citation-style') || 'APA';
  var sections = [];
  try {
    sections = JSON.parse(decodeURIComponent(root.getAttribute('data-sections') || '[]'));
  } catch (e) { sections = []; }

  var sources = [];
  var allTags = [];
  var sortMode = 'alpha';
  var filterTags = [];
  var filterSectionId = null;
  var notesLightMode = localStorage.getItem('crucible-notes-light') === '1';

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

  /* ── citation formatting (client-side) ──────────────────────────── */

  function parseAuthors(str) {
    if (!str) return [];
    return str.split(';').map(function (a) {
      var trimmed = a.trim();
      if (!trimmed) return null;
      if (trimmed.indexOf(',') !== -1) {
        var parts = trimmed.split(',').map(function (p) { return p.trim(); });
        return { last: parts[0] || '', first: parts.slice(1).join(' ').trim() };
      }
      var words = trimmed.split(/\s+/);
      if (words.length === 1) return { last: words[0], first: '' };
      return { last: words[words.length - 1], first: words.slice(0, -1).join(' ') };
    }).filter(function (a) { return a && a.last; });
  }

  function makeInitials(firstName, periods) {
    if (!firstName) return '';
    return firstName.split(/[\s-]+/).filter(Boolean).map(function (n) {
      return n[0].toUpperCase() + (periods ? '.' : '');
    }).join(periods ? ' ' : '');
  }

  function has(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }
  function em(text) { return '<em>' + text + '</em>'; }
  function doi2url(doi) {
    if (!doi) return '';
    doi = doi.trim();
    if (doi.indexOf('http') === 0) return doi;
    return 'https://doi.org/' + doi.replace(/^doi:\s*/i, '');
  }

  function inferType(src) {
    if (has(src.source_type)) return src.source_type.toLowerCase();
    if (has(src.conference_name)) return 'conference';
    if (has(src.chapter_name)) return 'chapter';
    if (has(src.journal_title)) return 'journal';
    return 'book';
  }

  function formatCitation(src, style) {
    if (!src) return '';
    var authors = parseAuthors(src.authors);
    var key = (style || 'APA').trim().toUpperCase();
    switch (key) {
      case 'APA': return fmtAPA(src, authors);
      case 'MLA': return fmtMLA(src, authors);
      case 'CHICAGO': return fmtChicago(src, authors);
      case 'HARVARD': return fmtHarvard(src, authors);
      case 'IEEE': return fmtIEEE(src, authors);
      case 'AMA': return fmtAMA(src, authors);
      case 'VANCOUVER': return fmtVancouver(src, authors);
      case 'TURABIAN': return fmtChicago(src, authors);
      default: return fmtAPA(src, authors);
    }
  }

  /* APA 7th */
  function apaAuth(authors) {
    var fmt = function (a) { return a.last + ', ' + makeInitials(a.first, true); };
    if (!authors.length) return '';
    if (authors.length === 1) return fmt(authors[0]);
    if (authors.length === 2) return fmt(authors[0]) + ', &amp; ' + fmt(authors[1]);
    if (authors.length <= 20)
      return authors.slice(0, -1).map(fmt).join(', ') + ', &amp; ' + fmt(authors[authors.length - 1]);
    return authors.slice(0, 19).map(fmt).join(', ') + ', . . . ' + fmt(authors[authors.length - 1]);
  }
  function fmtAPA(src, authors) {
    var type = inferType(src);
    var date = has(src.publication_date) ? '(' + src.publication_date + ')' : '(n.d.)';
    var a = apaAuth(authors);
    if (type === 'journal') {
      var r = a + '. ' + date + '. ' + escHtml(src.article_title) + '. ' + em(escHtml(src.journal_title));
      if (has(src.volume_number)) r += ', ' + em(src.volume_number);
      if (has(src.issue_number)) r += '(' + escHtml(src.issue_number) + ')';
      if (has(src.page_numbers)) r += ', ' + escHtml(src.page_numbers);
      r += '.';
      if (has(src.doi)) r += ' ' + doi2url(src.doi);
      else if (has(src.url)) r += ' ' + escHtml(src.url);
      return r;
    }
    if (type === 'chapter') {
      var bt = has(src.book_title) ? src.book_title : src.journal_title;
      var r = a + '. ' + date + '. ' + escHtml(src.chapter_name) + '. ';
      if (has(src.editors)) {
        var eds = parseAuthors(src.editors);
        var edStr = eds.map(function (e) { return makeInitials(e.first, true) + ' ' + e.last; }).join(', ');
        r += 'In ' + edStr + ' (Ed' + (eds.length > 1 ? 's' : '') + '.), ';
      } else { r += 'In '; }
      r += em(escHtml(bt));
      if (has(src.edition)) r += ' (' + escHtml(src.edition) + ')';
      if (has(src.page_numbers)) r += ' (pp. ' + escHtml(src.page_numbers) + ')';
      r += '.';
      if (has(src.publisher)) r += ' ' + escHtml(src.publisher) + '.';
      if (has(src.doi)) r += ' ' + doi2url(src.doi);
      else if (has(src.url)) r += ' ' + escHtml(src.url);
      return r;
    }
    if (type === 'conference') {
      var r = a + '. ' + date + '. ' + escHtml(src.article_title) + '. ';
      if (has(src.conference_name)) r += 'In ' + em(escHtml(src.conference_name));
      if (has(src.page_numbers)) r += ' (pp. ' + escHtml(src.page_numbers) + ')';
      r += '.';
      if (has(src.publisher)) r += ' ' + escHtml(src.publisher) + '.';
      if (has(src.doi)) r += ' ' + doi2url(src.doi);
      return r;
    }
    var r = a + '. ' + date + '. ' + em(escHtml(src.article_title || src.journal_title));
    if (has(src.edition)) r += ' (' + escHtml(src.edition) + ')';
    r += '.';
    if (has(src.publisher)) r += ' ' + escHtml(src.publisher) + '.';
    if (has(src.doi)) r += ' ' + doi2url(src.doi);
    return r;
  }

  /* MLA 9th */
  function mlaAuth(authors) {
    if (!authors.length) return '';
    if (authors.length === 1) return authors[0].last + ', ' + authors[0].first;
    if (authors.length === 2) return authors[0].last + ', ' + authors[0].first + ', and ' + authors[1].first + ' ' + authors[1].last;
    return authors[0].last + ', ' + authors[0].first + ', et al.';
  }
  function fmtMLA(src, authors) {
    var type = inferType(src);
    var a = mlaAuth(authors);
    if (type === 'journal') {
      var r = a + '. &ldquo;' + escHtml(src.article_title) + '.&rdquo; ' + em(escHtml(src.journal_title));
      if (has(src.volume_number)) r += ', vol. ' + escHtml(src.volume_number);
      if (has(src.issue_number)) r += ', no. ' + escHtml(src.issue_number);
      if (has(src.publication_date)) r += ', ' + escHtml(src.publication_date);
      if (has(src.page_numbers)) r += ', pp. ' + escHtml(src.page_numbers);
      r += '.';
      if (has(src.doi)) r += ' ' + doi2url(src.doi) + '.';
      return r;
    }
    if (type === 'chapter') {
      var bt = has(src.book_title) ? src.book_title : src.journal_title;
      var r = a + '. &ldquo;' + escHtml(src.chapter_name) + '.&rdquo; ' + em(escHtml(bt)) + ', ';
      if (has(src.editors)) {
        var eds = parseAuthors(src.editors);
        r += 'edited by ' + eds.map(function (e) { return e.first + ' ' + e.last; }).join(' and ') + ', ';
      }
      if (has(src.publisher)) r += escHtml(src.publisher) + ', ';
      if (has(src.publication_date)) r += escHtml(src.publication_date) + ', ';
      if (has(src.page_numbers)) r += 'pp. ' + escHtml(src.page_numbers);
      r = r.replace(/,\s*$/, '') + '.';
      return r;
    }
    var r = a + '. ' + em(escHtml(src.article_title || src.journal_title)) + '. ';
    if (has(src.publisher)) r += escHtml(src.publisher) + ', ';
    if (has(src.publication_date)) r += escHtml(src.publication_date);
    r = r.replace(/,\s*$/, '') + '.';
    return r;
  }

  /* Chicago 17th */
  function chicagoAuth(authors) {
    if (!authors.length) return '';
    var first = authors[0].last + ', ' + authors[0].first;
    if (authors.length === 1) return first;
    if (authors.length === 2) return first + ', and ' + authors[1].first + ' ' + authors[1].last;
    if (authors.length <= 10)
      return first + ', ' + authors.slice(1, -1).map(function (a) { return a.first + ' ' + a.last; }).join(', ') + ', and ' + authors[authors.length - 1].first + ' ' + authors[authors.length - 1].last;
    return first + ', ' + authors.slice(1, 7).map(function (a) { return a.first + ' ' + a.last; }).join(', ') + ', et al.';
  }
  function fmtChicago(src, authors) {
    var type = inferType(src);
    var a = chicagoAuth(authors);
    if (type === 'journal') {
      var r = a + '. &ldquo;' + escHtml(src.article_title) + '.&rdquo; ' + em(escHtml(src.journal_title));
      if (has(src.volume_number)) r += ' ' + escHtml(src.volume_number);
      if (has(src.issue_number)) r += ', no. ' + escHtml(src.issue_number);
      if (has(src.publication_date)) r += ' (' + escHtml(src.publication_date) + ')';
      if (has(src.page_numbers)) r += ': ' + escHtml(src.page_numbers);
      r += '.';
      if (has(src.doi)) r += ' ' + doi2url(src.doi) + '.';
      return r;
    }
    var r = a + '. ' + em(escHtml(src.article_title || src.journal_title)) + '.';
    if (has(src.publisher_location) && has(src.publisher)) r += ' ' + escHtml(src.publisher_location) + ': ' + escHtml(src.publisher) + ',';
    else if (has(src.publisher)) r += ' ' + escHtml(src.publisher) + ',';
    if (has(src.publication_date)) r += ' ' + escHtml(src.publication_date);
    r = r.replace(/,\s*$/, '') + '.';
    return r;
  }

  /* Harvard */
  function harvardAuth(authors) {
    var fmt = function (a) { return a.last + ', ' + makeInitials(a.first, true); };
    if (!authors.length) return '';
    if (authors.length === 1) return fmt(authors[0]);
    if (authors.length <= 3) return authors.slice(0, -1).map(fmt).join(', ') + ' and ' + fmt(authors[authors.length - 1]);
    return fmt(authors[0]) + ' et al.';
  }
  function fmtHarvard(src, authors) {
    var type = inferType(src);
    var a = harvardAuth(authors);
    var year = has(src.publication_date) ? src.publication_date : 'n.d.';
    if (type === 'journal') {
      var r = a + ' (' + year + ') &lsquo;' + escHtml(src.article_title) + '&rsquo;, ' + em(escHtml(src.journal_title));
      if (has(src.volume_number)) r += ', ' + escHtml(src.volume_number);
      if (has(src.issue_number)) r += '(' + escHtml(src.issue_number) + ')';
      if (has(src.page_numbers)) r += ', pp. ' + escHtml(src.page_numbers);
      r += '.';
      if (has(src.doi)) r += ' doi:' + src.doi.replace(/^doi:\s*/i, '') + '.';
      return r;
    }
    var r = a + ' (' + year + ') ' + em(escHtml(src.article_title || src.journal_title));
    if (has(src.edition)) r += ', ' + escHtml(src.edition);
    r += '.';
    if (has(src.publisher)) r += ' ' + escHtml(src.publisher) + '.';
    return r;
  }

  /* IEEE */
  function ieeeAuth(authors) {
    var fmt = function (a) { return makeInitials(a.first, true) + ' ' + a.last; };
    if (!authors.length) return '';
    if (authors.length === 1) return fmt(authors[0]);
    if (authors.length <= 6) return authors.slice(0, -1).map(fmt).join(', ') + ', and ' + fmt(authors[authors.length - 1]);
    return fmt(authors[0]) + ' et al.';
  }
  function fmtIEEE(src, authors) {
    var type = inferType(src);
    var a = ieeeAuth(authors);
    if (type === 'journal') {
      var r = a + ', &ldquo;' + escHtml(src.article_title) + ',&rdquo; ' + em(escHtml(src.journal_title));
      if (has(src.volume_number)) r += ', vol. ' + escHtml(src.volume_number);
      if (has(src.issue_number)) r += ', no. ' + escHtml(src.issue_number);
      if (has(src.page_numbers)) r += ', pp. ' + escHtml(src.page_numbers);
      if (has(src.publication_date)) r += ', ' + escHtml(src.publication_date);
      r += '.';
      if (has(src.doi)) r += ' doi: ' + src.doi.replace(/^doi:\s*/i, '') + '.';
      return r;
    }
    var r = a + ', ' + em(escHtml(src.article_title || src.journal_title)) + '.';
    if (has(src.publisher)) r += ' ' + escHtml(src.publisher);
    if (has(src.publication_date)) r += ', ' + escHtml(src.publication_date);
    r += '.';
    return r;
  }

  /* AMA 11th */
  function amaAuth(authors) {
    var fmt = function (a) { return a.last + ' ' + makeInitials(a.first, false); };
    if (!authors.length) return '';
    if (authors.length <= 6) return authors.map(fmt).join(', ');
    return authors.slice(0, 3).map(fmt).join(', ') + ', et al';
  }
  function fmtAMA(src, authors) {
    var type = inferType(src);
    var a = amaAuth(authors);
    if (type === 'journal') {
      var r = a + '. ' + escHtml(src.article_title) + '. ' + em(escHtml(src.journal_title)) + '.';
      if (has(src.publication_date)) r += ' ' + escHtml(src.publication_date);
      if (has(src.volume_number)) r += ';' + escHtml(src.volume_number);
      if (has(src.issue_number)) r += '(' + escHtml(src.issue_number) + ')';
      if (has(src.page_numbers)) r += ':' + escHtml(src.page_numbers);
      r += '.';
      if (has(src.doi)) r += ' doi:' + src.doi.replace(/^doi:\s*/i, '');
      return r;
    }
    var r = a + '. ' + em(escHtml(src.article_title || src.journal_title)) + '.';
    if (has(src.publisher)) r += ' ' + escHtml(src.publisher) + ';';
    if (has(src.publication_date)) r += ' ' + escHtml(src.publication_date);
    r += '.';
    return r;
  }

  /* Vancouver */
  function vanAuth(authors) {
    var fmt = function (a) { return a.last + ' ' + makeInitials(a.first, false); };
    if (!authors.length) return '';
    if (authors.length <= 6) return authors.map(fmt).join(', ');
    return authors.slice(0, 6).map(fmt).join(', ') + ', et al';
  }
  function fmtVancouver(src, authors) {
    var type = inferType(src);
    var a = vanAuth(authors);
    if (type === 'journal') {
      var r = a + '. ' + escHtml(src.article_title) + '. ' + escHtml(src.journal_title) + '.';
      if (has(src.publication_date)) r += ' ' + escHtml(src.publication_date);
      if (has(src.volume_number)) r += ';' + escHtml(src.volume_number);
      if (has(src.issue_number)) r += '(' + escHtml(src.issue_number) + ')';
      if (has(src.page_numbers)) r += ':' + escHtml(src.page_numbers);
      r += '.';
      if (has(src.doi)) r += ' doi:' + src.doi.replace(/^doi:\s*/i, '');
      return r;
    }
    var r = a + '. ' + escHtml(src.article_title || src.journal_title) + '.';
    if (has(src.publisher)) r += ' ' + escHtml(src.publisher) + ';';
    if (has(src.publication_date)) r += ' ' + escHtml(src.publication_date);
    r += '.';
    return r;
  }

  /* ── render ──────────────────────────────────────────────────────── */
  function render() {
    var filtered = getFiltered();

    var sectionFilterOpts = '<option value="">All sections</option>';
    sections.forEach(function (sec) {
      sectionFilterOpts += '<option value="' + sec.id + '"' + (filterSectionId === sec.id ? ' selected' : '') + '>' + escHtml(sec.title) + '</option>';
    });

    var activeTagCount = filterTags.length ? ' (' + filterTags.length + ')' : '';

    var html = '';

    /* sort / filter bar */
    html += '<div class="crucible-toolbar">' +
      '<div class="crucible-toolbar__left">' +
        '<span class="crucible-toolbar-spacer"></span>' +
        '<label class="crucible-sort-label">Sort: ' +
          '<select id="crucible-sort" class="crucible-select">' +
            '<option value="alpha"' + (sortMode === 'alpha' ? ' selected' : '') + '>Alphabetical</option>' +
            '<option value="date"' + (sortMode === 'date' ? ' selected' : '') + '>Date created</option>' +
          '</select>' +
        '</label>' +
        '<span class="crucible-toolbar-spacer"></span>' +
        '<button type="button" class="crucible-filter-btn" id="crucible-tag-filter-btn">Filter by tag' + escHtml(activeTagCount) + '</button>' +
        '<span class="crucible-toolbar-spacer"></span>' +
        '<label class="crucible-sort-label">Show Sources For: ' +
          '<select id="crucible-section-filter" class="crucible-select">' + sectionFilterOpts + '</select>' +
        '</label>' +
      '</div>' +
      '<div class="crucible-toolbar__right">' +
        '<span class="crucible-count">' + filtered.length + ' source' + (filtered.length !== 1 ? 's' : '') + '</span>' +
      '</div>' +
    '</div>';

    /* main area: scrollable list of source rows (tile + notes side by side) */
    html += '<div class="crucible-main">';
    if (!filtered.length) {
      html += '<div class="crucible-empty">No sources yet. Click &ldquo;Add a Source&rdquo; below to get started.</div>';
    } else {
      filtered.forEach(function (src) {
        var formattedCitation = formatCitation(src, citationStyle);
        var tagBadges = '';
        (src.tags || []).forEach(function (t) {
          tagBadges += '<span class="crucible-tag-badge">' + escHtml(t) + '</span>';
        });
        html += '<div class="crucible-source-row" data-source-id="' + src.id + '">' +
          '<div class="crucible-tile">' +
            '<div class="crucible-tile__header">' +
              '<span class="crucible-tile__title">' + escHtml(src.article_title || src.citation_text || '(Untitled)') + '</span>' +
              '<span class="crucible-tile__actions">' +
                '<button type="button" class="crucible-tile-btn crucible-tile-btn--edit" data-source-id="' + src.id + '" title="Edit source">&#9998;</button>' +
                '<button type="button" class="crucible-tile-btn crucible-tile-btn--delete" data-source-id="' + src.id + '" title="Delete source">&times;</button>' +
              '</span>' +
            '</div>' +
            '<div class="crucible-tile__citation">' + formattedCitation + '</div>' +
            (tagBadges ? '<div class="crucible-tile__tags">' + tagBadges + '</div>' : '') +
          '</div>' +
          '<div class="crucible-note-tile' + (notesLightMode ? ' crucible-note-tile--light' : '') + '">' +
            '<div class="crucible-note-tile__editor" contenteditable="true" data-source-id="' + src.id + '">' + (src.crucible_notes || '') + '</div>' +
            '<div class="crucible-note-tile__toolbar">' +
              '<button type="button" class="crucible-notes-fmt-btn crucible-note-bold" data-source-id="' + src.id + '" title="Bold"><strong>B</strong></button>' +
              '<button type="button" class="crucible-notes-fmt-btn crucible-note-ul" data-source-id="' + src.id + '" title="Bulleted list">&#8226; List</button>' +
              '<button type="button" class="crucible-notes-fmt-btn crucible-notes-save-btn crucible-note-save" data-source-id="' + src.id + '">Save</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      });
    }
    html += '</div>';

    /* action bar */
    html += '<div class="crucible-action-bar">' +
      '<button type="button" class="crucible-add-btn" id="crucible-add-source-btn">Add a Source</button>' +
      '<div class="crucible-paper-toggle-wrap">' +
        '<button type="button" id="crucible-paper-toggle" class="anvil-paper-toggle" role="switch" aria-checked="' + (notesLightMode ? 'true' : 'false') + '" title="Toggle light/dark notes mode">' +
          '<span class="anvil-paper-toggle__track"><span class="anvil-paper-toggle__thumb"></span></span>' +
        '</button>' +
        '<span id="crucible-paper-hint" class="anvil-paper-toggle__hint">' + (notesLightMode ? 'LIGHT MODE' : 'DARK MODE') + '</span>' +
      '</div>' +
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
        openDeleteConfirmModal(sid);
      });
    });

    root.querySelectorAll('.crucible-note-bold').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = btn.getAttribute('data-source-id');
        var editor = root.querySelector('.crucible-note-tile__editor[data-source-id="' + sid + '"]');
        if (editor) { editor.focus(); document.execCommand('bold', false, null); }
      });
    });

    root.querySelectorAll('.crucible-note-ul').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = btn.getAttribute('data-source-id');
        var editor = root.querySelector('.crucible-note-tile__editor[data-source-id="' + sid + '"]');
        if (editor) { editor.focus(); document.execCommand('insertUnorderedList', false, null); }
      });
    });

    root.querySelectorAll('.crucible-note-save').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = parseInt(btn.getAttribute('data-source-id'), 10);
        var editor = root.querySelector('.crucible-note-tile__editor[data-source-id="' + sid + '"]');
        if (!editor) return;
        var notesHtml = editor.innerHTML;
        api('PATCH', '/sources/' + sid, { crucible_notes: notesHtml }).then(function (d) {
          var idx = sources.findIndex(function (s) { return s.id === d.source.id; });
          if (idx !== -1) sources[idx] = d.source;
          btn.textContent = 'Saved!';
          setTimeout(function () { btn.textContent = 'Save'; }, 1500);
        }).catch(function (e) { openAlertModal(e.message); });
      });
    });

    var paperToggle = document.getElementById('crucible-paper-toggle');
    if (paperToggle) paperToggle.addEventListener('click', function () {
      notesLightMode = !notesLightMode;
      localStorage.setItem('crucible-notes-light', notesLightMode ? '1' : '0');
      paperToggle.setAttribute('aria-checked', notesLightMode ? 'true' : 'false');
      var hint = document.getElementById('crucible-paper-hint');
      if (hint) hint.textContent = notesLightMode ? 'LIGHT MODE' : 'DARK MODE';
      root.querySelectorAll('.crucible-note-tile').forEach(function (t) {
        if (notesLightMode) t.classList.add('crucible-note-tile--light');
        else t.classList.remove('crucible-note-tile--light');
      });
    });
  }

  /* ── delete confirmation modal ──────────────────────────────────── */
  function openDeleteConfirmModal(sourceId) {
    closeModal();
    var overlay = document.createElement('div');
    overlay.className = 'crucible-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'crucible-modal crucible-modal--sm';

    modal.innerHTML =
      '<div class="crucible-modal__header"><h2>Delete Source</h2>' +
        '<button type="button" class="crucible-modal__close" id="crucible-modal-close">&times;</button></div>' +
      '<div class="crucible-modal__body"><p>Are you sure you want to delete this source? This cannot be undone.</p></div>' +
      '<div class="crucible-modal__footer">' +
        '<button type="button" class="crucible-btn crucible-btn--secondary" id="crucible-delete-cancel">Cancel</button>' +
        '<button type="button" class="crucible-btn crucible-btn--danger" id="crucible-delete-confirm">Delete</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.getElementById('crucible-modal-close').addEventListener('click', closeModal);
    document.getElementById('crucible-delete-cancel').addEventListener('click', closeModal);
    document.getElementById('crucible-delete-confirm').addEventListener('click', function () {
      api('DELETE', '/sources/' + sourceId).then(function () {
        sources = sources.filter(function (s) { return s.id !== sourceId; });
        collectAllTags();
        closeModal();
        render();
        fetchSuggestions();
      }).catch(function (e) { closeModal(); openAlertModal(e.message); });
    });
  }

  /* ── generic alert modal ────────────────────────────────────────── */
  function openAlertModal(message) {
    closeModal();
    var overlay = document.createElement('div');
    overlay.className = 'crucible-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'crucible-modal crucible-modal--sm';

    modal.innerHTML =
      '<div class="crucible-modal__header"><h2>Notice</h2>' +
        '<button type="button" class="crucible-modal__close" id="crucible-modal-close">&times;</button></div>' +
      '<div class="crucible-modal__body"><p>' + escHtml(message) + '</p></div>' +
      '<div class="crucible-modal__footer">' +
        '<button type="button" class="crucible-btn crucible-btn--primary" id="crucible-alert-ok">OK</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.getElementById('crucible-modal-close').addEventListener('click', closeModal);
    document.getElementById('crucible-alert-ok').addEventListener('click', closeModal);
  }

  /* ── tag filter modal ───────────────────────────────────────────── */
  function openTagFilterModal() {
    closeModal();
    if (!allTags.length) {
      openAlertModal('No tags have been created yet. Add tags to your sources to use this filter.');
      return;
    }

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

    var sourceTypeOpts = ['', 'journal', 'book', 'chapter', 'conference'].map(function (t) {
      var sel = (v.source_type || '') === t ? ' selected' : '';
      var label = t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Auto-detect';
      return '<option value="' + t + '"' + sel + '>' + label + '</option>';
    }).join('');

    var html = '<div class="crucible-modal__header"><h2>' + (isEdit ? 'Edit Source' : 'Add a Source') + '</h2>' +
      '<button type="button" class="crucible-modal__close" id="crucible-modal-close">&times;</button></div>';
    html += '<form id="crucible-source-form" class="crucible-modal__body">';

    html += '<div class="crucible-form-row crucible-form-row--half">' +
      '<label>Source Type:<select name="source_type" id="crucible-source-type" class="crucible-select crucible-select--full">' + sourceTypeOpts + '</select></label>' +
      '<label>Publication Date:<input type="text" name="publication_date" value="' + escHtml(v.publication_date || '') + '" placeholder="e.g. 2024"></label>' +
    '</div>';
    html += '<div class="crucible-form-row">' +
      '<label>Author(s): <span class="crucible-hint">(separate by semicolon)</span><input type="text" name="authors" value="' + escHtml(v.authors || '') + '" placeholder="e.g. John Smith; Jane Doe or Smith, John; Doe, Jane"></label>' +
    '</div>';
    html += '<div class="crucible-form-row">' +
      '<label>Article / Work Title:<input type="text" name="article_title" value="' + escHtml(v.article_title || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row" data-field-group="journal">' +
      '<label>Journal / Publication Title:<input type="text" name="journal_title" value="' + escHtml(v.journal_title || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row" data-field-group="chapter">' +
      '<label>Book Title:<input type="text" name="book_title" value="' + escHtml(v.book_title || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row crucible-form-row--third" data-field-group="journal">' +
      '<label>Volume:<input type="text" name="volume_number" value="' + escHtml(v.volume_number || '') + '"></label>' +
      '<label>Issue:<input type="text" name="issue_number" value="' + escHtml(v.issue_number || '') + '"></label>' +
      '<label>Page(s):<input type="text" name="page_numbers" value="' + escHtml(v.page_numbers || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row" data-field-group="pages-only" style="display:none">' +
      '<label>Page(s):<input type="text" name="page_numbers_alt" value="' + escHtml(v.page_numbers || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row">' +
      '<label>DOI:<input type="text" name="doi" value="' + escHtml(v.doi || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row crucible-form-row--half" data-field-group="publisher">' +
      '<label>Publisher:<input type="text" name="publisher" value="' + escHtml(v.publisher || '') + '"></label>' +
      '<label>Publisher Location:<input type="text" name="publisher_location" value="' + escHtml(v.publisher_location || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row crucible-form-row--half" data-field-group="edition">' +
      '<label>Edition: <span class="crucible-hint">(e.g. 2nd ed.)</span><input type="text" name="edition" value="' + escHtml(v.edition || '') + '"></label>' +
      '<label>Editors: <span class="crucible-hint">(semicolon separated)</span><input type="text" name="editors" value="' + escHtml(v.editors || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row" data-field-group="chapter">' +
      '<label>Chapter Name:<input type="text" name="chapter_name" value="' + escHtml(v.chapter_name || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row" data-field-group="conference">' +
      '<label>Conference Name:<input type="text" name="conference_name" value="' + escHtml(v.conference_name || '') + '"></label>' +
    '</div>';
    html += '<div class="crucible-form-row">' +
      '<label>Tags: <span class="crucible-hint">(comma separated)</span><input type="text" name="tags" value="' + escHtml((v.tags || []).join(', ')) + '"></label>' +
    '</div>';
    if (sections.length) {
      html += '<div class="crucible-form-row"><span class="crucible-field-label">Applicable Sections:</span>' +
        '<div class="crucible-section-checks">' +
        '<label class="crucible-section-check crucible-section-check--all"><input type="checkbox" id="crucible-select-all-sections"> <strong>Select All</strong></label>' +
        sectionChecks + '</div></div>';
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

    var typeSelect = document.getElementById('crucible-source-type');
    if (typeSelect) {
      typeSelect.addEventListener('change', function () { applyFieldVisibility(modal, this.value); });
      applyFieldVisibility(modal, typeSelect.value);
    }

    var selectAllCb = document.getElementById('crucible-select-all-sections');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', function () {
        var checked = this.checked;
        modal.querySelectorAll('input[name="section_ids"]').forEach(function (cb) {
          cb.checked = checked;
        });
      });
    }
  }

  function applyFieldVisibility(modal, sourceType) {
    var groups = {
      '':          { journal: true, chapter: true, conference: true, publisher: true, edition: true, 'pages-only': false },
      'journal':   { journal: true, chapter: false, conference: false, publisher: false, edition: false, 'pages-only': false },
      'book':      { journal: false, chapter: false, conference: false, publisher: true, edition: true, 'pages-only': false },
      'chapter':   { journal: false, chapter: true, conference: false, publisher: true, edition: true, 'pages-only': true },
      'conference': { journal: false, chapter: false, conference: true, publisher: true, edition: false, 'pages-only': true },
    };
    var vis = groups[sourceType] || groups[''];
    modal.querySelectorAll('[data-field-group]').forEach(function (el) {
      var group = el.getAttribute('data-field-group');
      el.style.display = vis[group] ? '' : 'none';
    });
  }

  function saveSource(existingId) {
    var form = document.getElementById('crucible-source-form');
    if (!form) return;
    var fd = new FormData(form);

    var pages = fd.get('page_numbers') || fd.get('page_numbers_alt') || '';
    var payload = {
      source_type: fd.get('source_type') || '',
      authors: fd.get('authors') || '',
      publication_date: fd.get('publication_date') || '',
      article_title: fd.get('article_title') || '',
      journal_title: fd.get('journal_title') || '',
      book_title: fd.get('book_title') || '',
      volume_number: fd.get('volume_number') || '',
      issue_number: fd.get('issue_number') || '',
      page_numbers: pages,
      doi: fd.get('doi') || '',
      publisher: fd.get('publisher') || '',
      publisher_location: fd.get('publisher_location') || '',
      edition: fd.get('edition') || '',
      editors: fd.get('editors') || '',
      chapter_name: fd.get('chapter_name') || '',
      conference_name: fd.get('conference_name') || '',
      citation_text: fd.get('article_title') || '',
      tags: (fd.get('tags') || '').split(/[,;]/).map(function (t) { return t.trim(); }).filter(Boolean),
      section_ids: fd.getAll('section_ids').map(function (v) { return parseInt(v, 10); }),
    };

    if (!payload.article_title) {
      openAlertModal('Article / work title is required.');
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
      }
      collectAllTags();
      closeModal();
      render();
      fetchSuggestions();
    }).catch(function (e) { openAlertModal(e.message); });
  }

  /* ── modal close ────────────────────────────────────────────────── */
  function closeModal() {
    var overlay = document.querySelector('.crucible-modal-overlay');
    if (overlay) overlay.remove();
  }

  /* ── source suggestions (Semantic Scholar) ────────────────────── */
  function extractKeywords() {
    var kws = [];
    sources.forEach(function (s) {
      if (s.article_title) kws.push(s.article_title);
    });
    return kws;
  }

  function fetchSuggestions() {
    var panel = document.getElementById('crucible-suggestions');
    if (!panel) return;
    var kws = extractKeywords();
    if (!kws.length) {
      panel.innerHTML = '<div class="crucible-sug-empty">Add sources to see related paper suggestions.</div>';
      return;
    }
    panel.innerHTML = '<div class="crucible-sug-loading">Searching for related papers…</div>';
    var q = kws.join(',');
    fetch('/api/projects/' + projectId + '/sources/search-scholar?q=' + encodeURIComponent(q) + '&limit=20', {
      credentials: 'same-origin'
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Request failed (' + r.status + ')');
          return d;
        });
      })
      .then(function (d) {
        if (!d.papers || !d.papers.length) {
          panel.innerHTML = '<div class="crucible-sug-empty">No related papers found.</div>';
          return;
        }
        var html = '';
        d.papers.forEach(function (p) {
          var authors = (p.authors || []).slice(0, 3).join(', ');
          if (p.authors && p.authors.length > 3) authors += ' et al.';
          html += '<div class="crucible-sug-card">';
          html += '<div class="crucible-sug-card__title">';
          if (p.url) html += '<a href="' + escHtml(p.url) + '" target="_blank" rel="noopener">' + escHtml(p.title) + '</a>';
          else html += escHtml(p.title);
          html += '</div>';
          if (authors) html += '<div class="crucible-sug-card__authors">' + escHtml(authors) + '</div>';
          var meta = [];
          if (p.year) meta.push(String(p.year));
          if (p.citationCount != null) meta.push(p.citationCount + ' citations');
          if (meta.length) html += '<div class="crucible-sug-card__meta">' + escHtml(meta.join(' · ')) + '</div>';
          if (p.abstract) html += '<div class="crucible-sug-card__abstract">' + escHtml(p.abstract) + '</div>';
          html += '</div>';
        });
        panel.innerHTML = html;
      })
      .catch(function (e) {
        var msg = (e && e.message) || 'Could not load suggestions.';
        panel.innerHTML = '<div class="crucible-sug-empty">' + escHtml(msg) + '</div>';
      });
  }

  /* ── init ────────────────────────────────────────────────────────── */
  api('GET', '/sources').then(function (d) {
    sources = d.sources || [];
    collectAllTags();
    render();
    fetchSuggestions();
  }).catch(function (e) {
    root.innerHTML = '<div class="crucible-empty">Failed to load sources: ' + escHtml(e.message) + '</div>';
  });
})();
