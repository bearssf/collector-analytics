/**
 * Anvil2 (beta) — structured anchor-based feedback (see docs/ai-feedback-system-spec.md).
 * Uses POST /api/.../review-structured (no persistence to anvil_suggestions).
 */
(function () {
  var root = document.getElementById('anvil2-root');
  if (!root) return;

  var projectId = parseInt(root.dataset.projectId, 10);
  if (Number.isNaN(projectId)) return;

  var bundle = null;
  var selectedId = null;
  var quill = null;
  var debounceTimer = null;
  var reviewTimer = null;
  var lastReviewAt = 0;
  var lastPlainSent = '';
  var MIN_REVIEW_INTERVAL_MS = 22000;
  var DEBOUNCE_MS = 1800;

  /** @type {{ item: object, status: string, matchPosition: {start:number,end:number}|null }[]} */
  var feedbackRows = [];

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function api(path, method, body) {
    var opts = {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var res = await fetch('/api' + path, opts);
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error('Invalid response from server');
    }
    if (!res.ok) {
      throw new Error((data && data.error) || res.statusText || 'Request failed');
    }
    return data;
  }

  function sectionById(id) {
    if (!bundle || !bundle.sections) return null;
    var n = Number(id);
    return bundle.sections.find(function (s) {
      return Number(s.id) === n;
    });
  }

  function sectionBodyProp(sec) {
    if (!sec) return '';
    return sec.body != null ? String(sec.body) : '';
  }

  function getPlain(quillInst) {
    if (!quillInst) return '';
    return quillInst.getText().replace(/\n+$/, '');
  }

  function findAnchor(documentText, item) {
    if (!item || !item.anchorText) return null;
    var anchor = String(item.anchorText);
    var before = item.contextBefore != null ? String(item.contextBefore) : '';
    var after = item.contextAfter != null ? String(item.contextAfter) : '';
    var fullPattern = before + anchor + after;
    var idx = documentText.indexOf(fullPattern);
    if (idx !== -1) {
      var start = idx + before.length;
      return { start: start, end: start + anchor.length };
    }
    idx = documentText.indexOf(anchor);
    if (idx !== -1) {
      return { start: idx, end: idx + anchor.length };
    }
    return null;
  }

  function rebaseFeedback(documentText) {
    feedbackRows = feedbackRows.map(function (row) {
      if (row.status === 'applied' || row.status === 'dismissed') return row;
      var m = findAnchor(documentText, row.item);
      if (m) {
        return { item: row.item, status: 'active', matchPosition: m };
      }
      if (row.item.suggestion && String(row.item.suggestion).trim() && documentText.indexOf(String(row.item.suggestion)) !== -1) {
        return { item: row.item, status: 'applied', matchPosition: null };
      }
      return { item: row.item, status: 'conflicted', matchPosition: null };
    });
  }

  function setRowsFromApi(items) {
    feedbackRows = (items || []).map(function (it) {
      return { item: it, status: 'active', matchPosition: null };
    });
    rebaseFeedback(getPlain(quill));
    renderFeedbackRail();
  }

  function itemHasReplacement(it) {
    if (!it || it.suggestion == null) return false;
    return String(it.suggestion).trim() !== '';
  }

  function applyFeedbackRow(row) {
    if (!quill || !row || row.status !== 'active') return;
    if (!row.item.isActionable && !itemHasReplacement(row.item)) return;
    var plain = getPlain(quill);
    var m = findAnchor(plain, row.item);
    if (!m) {
      row.status = 'conflicted';
      renderFeedbackRail();
      return;
    }
    var sug = row.item.suggestion != null ? String(row.item.suggestion) : '';
    var len = m.end - m.start;
    var docLen = quill.getLength();
    if (m.start < 0 || m.start + len > docLen) {
      row.status = 'conflicted';
      renderFeedbackRail();
      return;
    }
    /* Use Quill source 'silent' so this doesn't emit text-change — otherwise Apply would
       debounce-schedule another Bedrock review like a normal keystroke. */
    quill.deleteText(m.start, len, 'silent');
    quill.insertText(m.start, sug, 'silent');
    row.status = 'applied';
    row.matchPosition = null;
    rebaseFeedback(getPlain(quill));
    renderFeedbackRail();
    scheduleSave();
  }

  function dismissRow(itemId) {
    feedbackRows = feedbackRows.map(function (row) {
      if (String(row.item.id) !== String(itemId)) return row;
      if (row.status === 'applied' || row.status === 'dismissed') return row;
      return { item: row.item, status: 'dismissed', matchPosition: null };
    });
    renderFeedbackRail();
  }

  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveSectionDraft();
    }, 700);
  }

  async function saveSectionDraft() {
    if (!quill || selectedId == null || !bundle) return;
    try {
      var html =
        quill.root && quill.root.innerHTML ? String(quill.root.innerHTML) : '';
      await api('/projects/' + projectId + '/sections/' + selectedId, 'PATCH', { body: html });
      var sec = sectionById(selectedId);
      if (sec) sec.body = html;
    } catch (e) {
      /* best-effort */
    }
  }

  function renderFeedbackRail() {
    var mount = document.getElementById('anvil2-feedback-mount');
    if (!mount) return;
    if (!feedbackRows.length) {
      mount.innerHTML =
        '<p class="anvil2-feedback-placeholder">Pause typing to request AI feedback. Suggestions appear here (beta).</p>';
      return;
    }
    var html = '<ul class="anvil2-feedback-list">';
    feedbackRows.forEach(function (row) {
      var st = row.status;
      var it = row.item;
      var cat = String(it.category || 'other').toLowerCase();
      html += '<li class="anvil2-feedback-card anvil2-feedback-card--' + escapeHtml(st) + '">';
      html += '<div class="anvil2-feedback-card-head">';
      html +=
        '<span class="anvil2-feedback-cat-pill">' +
        escapeHtml(cat) +
        '</span>';
      html += '<span class="anvil2-feedback-id">' + escapeHtml(it.id) + '</span>';
      html += '<span class="anvil2-feedback-status">' + escapeHtml(st) + '</span>';
      html += '</div>';
      if (it.rationale) {
        html += '<p class="anvil2-feedback-rationale">' + escapeHtml(it.rationale) + '</p>';
      }
      if (it.anchorText) {
        html +=
          '<p class="anvil2-feedback-anchor"><span class="anvil2-feedback-k">Anchor</span> ' +
          escapeHtml(it.anchorText) +
          '</p>';
      }
      var canShowSuggestion = st === 'active' && itemHasReplacement(it);
      if (canShowSuggestion) {
        html +=
          '<p class="anvil2-feedback-suggestion"><span class="anvil2-feedback-k">→</span> ' +
          escapeHtml(String(it.suggestion)) +
          '</p>';
      }
      if (st === 'conflicted') {
        html +=
          '<p class="anvil2-feedback-conflict">This suggestion no longer matches the text. Edit the draft or wait for a new review.</p>';
      }
      html += '<div class="anvil2-feedback-actions">';
      var canApply = st === 'active' && (it.isActionable || itemHasReplacement(it));
      if (canApply) {
        html +=
          '<button type="button" class="app-btn-primary anvil2-apply" data-fid="' +
          escapeHtml(String(it.id)) +
          '">Apply</button>';
      }
      if (st === 'active' || st === 'conflicted') {
        html +=
          '<button type="button" class="anvil2-dismiss" data-dismiss="' +
          escapeHtml(String(it.id)) +
          '">Dismiss</button>';
      }
      html += '</div></li>';
    });
    html += '</ul>';
    mount.innerHTML = html;
  }

  function requestStructuredReview() {
    if (!quill || selectedId == null) return;
    var plain = getPlain(quill);
    if (plain.length < 20) return;
    if (plain === lastPlainSent) return;
    var now = Date.now();
    if (now - lastReviewAt < MIN_REVIEW_INTERVAL_MS) return;

    lastReviewAt = now;
    lastPlainSent = plain;
    var html = quill.root && quill.root.innerHTML ? String(quill.root.innerHTML) : '';

    var mount = document.getElementById('anvil2-feedback-mount');
    if (mount) {
      mount.innerHTML = '<p class="anvil2-feedback-placeholder">Fetching AI feedback…</p>';
    }

    api('/projects/' + projectId + '/sections/' + selectedId + '/review-structured', 'POST', {
      html: html,
      plainText: plain,
    })
      .then(function (data) {
        var items = (data && data.items) || [];
        if (data && data.skipped && data.shortDraft) {
          if (mount) {
            mount.innerHTML =
              '<p class="anvil2-feedback-placeholder">Add a bit more text for feedback.</p>';
          }
          return;
        }
        setRowsFromApi(items);
      })
      .catch(function (e) {
        lastPlainSent = '';
        if (mount) {
          mount.innerHTML =
            '<p class="anvil2-feedback-placeholder anvil2-feedback-err" role="alert">' +
            escapeHtml(e.message || 'Request failed') +
            '</p>';
        }
      });
  }

  function scheduleReview() {
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = setTimeout(function () {
      reviewTimer = null;
      requestStructuredReview();
    }, DEBOUNCE_MS);
  }

  function mountEditor(rawDraft) {
    var wrap = document.getElementById('anvil2-quill-wrap');
    var host = document.getElementById('anvil2-editor');
    if (!wrap || !host) return;
    quill = null;
    var draftStr = rawDraft != null && String(rawDraft).trim() ? String(rawDraft) : '';
    if (typeof Quill === 'undefined') {
      wrap.innerHTML =
        '<textarea id="anvil2-fallback" class="anvil-textarea" rows="16"></textarea>';
      var ta = document.getElementById('anvil2-fallback');
      if (ta) {
        ta.value = draftStr;
        ta.addEventListener('input', scheduleReview);
      }
      return;
    }
    quill = new Quill('#anvil2-editor', {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link'],
          ['clean'],
        ],
      },
      placeholder: 'Write here — feedback loads after you pause typing (beta).',
    });
    if (draftStr) {
      try {
        var delta = quill.clipboard.convert({ html: draftStr });
        quill.setContents(delta, 'silent');
      } catch (e) {
        quill.setText(draftStr);
      }
    }
    quill.on('text-change', function () {
      scheduleSave();
      scheduleReview();
    });
  }

  function render() {
    if (!bundle) return;
    var sections = bundle.sections || [];
    if (!sections.length) {
      root.innerHTML =
        '<div class="anvil2-panel"><p class="anvil-muted">No sections in this project.</p></div>';
      return;
    }
    if (selectedId == null) selectedId = Number(sections[0].id);
    var current = sectionById(selectedId);
    if (!current && sections.length) {
      selectedId = Number(sections[0].id);
      current = sectionById(selectedId);
    }
    var draft = sectionBodyProp(current);

    var opts = '';
    sections.forEach(function (s) {
      opts +=
        '<option value="' +
        Number(s.id) +
        '"' +
        (Number(s.id) === Number(selectedId) ? ' selected' : '') +
        '>' +
        escapeHtml(s.title || 'Section') +
        '</option>';
    });

    root.innerHTML =
      '<div class="anvil2-panel">' +
      '<div class="anvil2-toolbar">' +
      '<label class="anvil2-section-label">Section' +
      '<select id="anvil2-section-select" class="anvil2-section-select">' +
      opts +
      '</select></label>' +
      '</div>' +
      '<div id="anvil2-quill-wrap" class="anvil2-quill-wrap"><div id="anvil2-editor" class="anvil2-quill"></div></div>' +
      '</div>';

    mountEditor(draft);
    feedbackRows = [];
    lastPlainSent = '';
    renderFeedbackRail();
    document.getElementById('anvil2-section-select').addEventListener('change', function (e) {
      selectedId = parseInt(e.target.value, 10);
      render();
    });
  }

  /** Feedback buttons live in the right rail (#anvil2-feedback-mount), outside #anvil2-root — delegate on document. */
  document.addEventListener('click', function (e) {
    if (!document.getElementById('anvil2-root')) return;
    var ap = e.target.closest('.anvil2-apply');
    if (ap) {
      e.preventDefault();
      var fid = ap.getAttribute('data-fid');
      var row = feedbackRows.find(function (r) {
        return String(r.item.id) === String(fid);
      });
      if (row) applyFeedbackRow(row);
      return;
    }
    var dis = e.target.closest('.anvil2-dismiss');
    if (dis) {
      e.preventDefault();
      dismissRow(dis.getAttribute('data-dismiss'));
    }
  });

  async function load() {
    root.innerHTML = '<p class="anvil-loading">Loading…</p>';
    try {
      bundle = await api('/projects/' + projectId, 'GET');
      var u = new URL(window.location.href);
      var sq = u.searchParams.get('section');
      if (sq != null && bundle.sections) {
        var n = parseInt(sq, 10);
        if (
          !Number.isNaN(n) &&
          bundle.sections.some(function (s) {
            return Number(s.id) === n;
          })
        ) {
          selectedId = n;
        }
      }
    } catch (e) {
      root.innerHTML =
        '<p class="anvil-error-banner" role="alert">Could not load project. ' + escapeHtml(e.message) + '</p>';
      return;
    }
    render();
  }

  load();
})();
