/**
 * Anvil2 (beta) — structured anchor-based feedback (see docs/ai-feedback-system-spec.md).
 * POST /api/.../review-structured (no persistence to anvil_suggestions).
 */
(function () {
  var root = document.getElementById('anvil2-root');
  if (!root) return;

  var projectId = parseInt(root.dataset.projectId, 10);
  if (Number.isNaN(projectId)) return;

  var initialIdleMs = parseInt(root.dataset.initialIdleMs || '1800', 10);
  if (Number.isNaN(initialIdleMs) || initialIdleMs < 0) initialIdleMs = 1800;
  var incrementalChars = parseInt(root.dataset.incrementalChars || '40', 10);
  if (Number.isNaN(incrementalChars) || incrementalChars < 1) incrementalChars = 40;

  var bundle = null;
  var selectedId = null;
  var quill = null;
  var initialTimer = null;
  var lastReviewAt = 0;
  var lastPlainSent = '';
  var MIN_REVIEW_INTERVAL_MS = 22000;
  /** Matches lib/bedrockReview MIN_DRAFT_PLAIN_CHARS */
  var MIN_PLAIN_CHARS = 15;

  var hasCompletedInitialReview = false;
  var charsSinceFingerprint = 0;

  function recordTextFingerprint() {
    var fp = getDraftPlain();
    root.dataset.fpChars = String(fp.length);
  }
  var reviewInFlight = false;
  var taLastLen = 0;

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

  function getDraftPlain() {
    if (quill) return getPlain(quill);
    var ta = document.getElementById('anvil2-fallback');
    return ta ? String(ta.value).replace(/\n+$/, '') : '';
  }

  function getDraftHtml() {
    if (quill) {
      return quill.root && quill.root.innerHTML ? String(quill.root.innerHTML) : '';
    }
    var ta = document.getElementById('anvil2-fallback');
    if (!ta) return '';
    var esc = escapeHtml(ta.value);
    return '<p>' + esc.replace(/\n/g, '</p><p>') + '</p>';
  }

  function deltaChangeSize(delta) {
    if (!delta || !delta.ops) return 0;
    var n = 0;
    for (var i = 0; i < delta.ops.length; i++) {
      var op = delta.ops[i];
      if (typeof op.insert === 'string') n += op.insert.length;
      if (typeof op.delete === 'number') n += op.delete;
    }
    return n;
  }

  function setAnalyzeBanner(visible, text) {
    var el = document.getElementById('anvil2-analyze-banner');
    if (!el) return;
    if (visible) {
      el.hidden = false;
      el.textContent = text || 'Analyzing new text…';
    } else {
      el.hidden = true;
      el.textContent = '';
    }
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

  /** Drop rows that no longer anchor; conflicted items are removed from the list. */
  function rebaseFeedback(documentText) {
    feedbackRows = feedbackRows.flatMap(function (row) {
      if (row.status === 'applied' || row.status === 'dismissed') return [row];
      var m = findAnchor(documentText, row.item);
      if (m) {
        return [{ item: row.item, status: 'active', matchPosition: m }];
      }
      if (row.item.suggestion && String(row.item.suggestion).trim() && documentText.indexOf(String(row.item.suggestion)) !== -1) {
        return [{ item: row.item, status: 'applied', matchPosition: null }];
      }
      return [];
    });
  }

  function setRowsFromApi(items) {
    feedbackRows = (items || []).map(function (it) {
      return { item: it, status: 'active', matchPosition: null };
    });
    rebaseFeedback(getDraftPlain());
    renderFeedbackRail();
  }

  function appendRowsFromApi(items) {
    var plain = getDraftPlain();
    var existingIds = {};
    feedbackRows.forEach(function (r) {
      existingIds[String(r.item.id)] = true;
    });
    var prepend = [];
    (items || []).forEach(function (it) {
      if (existingIds[String(it.id)]) return;
      var row = { item: it, status: 'active', matchPosition: null };
      var m = findAnchor(plain, row.item);
      if (!m) return;
      row.matchPosition = m;
      prepend.push(row);
      existingIds[String(it.id)] = true;
    });
    feedbackRows = prepend.concat(feedbackRows);
    rebaseFeedback(plain);
    renderFeedbackRail();
  }

  function itemHasReplacement(it) {
    if (!it || it.suggestion == null) return false;
    return String(it.suggestion).trim() !== '';
  }

  function applyFeedbackRow(row) {
    if (!quill || !row || row.status !== 'active') return;
    if (!row.item.isActionable && !itemHasReplacement(row.item)) return;
    if (!quill) return;
    var plain = getDraftPlain();
    var m = findAnchor(plain, row.item);
    if (!m) {
      feedbackRows = feedbackRows.filter(function (r) {
        return r !== row;
      });
      renderFeedbackRail();
      return;
    }
    var sug = row.item.suggestion != null ? String(row.item.suggestion) : '';
    var len = m.end - m.start;
    var docLen = quill.getLength();
    if (m.start < 0 || m.start + len > docLen) {
      feedbackRows = feedbackRows.filter(function (r) {
        return r !== row;
      });
      renderFeedbackRail();
      return;
    }
    quill.deleteText(m.start, len, 'silent');
    quill.insertText(m.start, sug, 'silent');
    row.status = 'applied';
    row.matchPosition = null;
    rebaseFeedback(getDraftPlain());
    renderFeedbackRail();
    scheduleSave();
    charsSinceFingerprint = 0;
    recordTextFingerprint();
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
    if (selectedId == null || !bundle) return;
    if (!quill && !document.getElementById('anvil2-fallback')) return;
    try {
      var html = getDraftHtml();
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
      html += '<div class="anvil2-feedback-actions">';
      var canApply = st === 'active' && (it.isActionable || itemHasReplacement(it));
      if (canApply) {
        html +=
          '<button type="button" class="app-btn-primary anvil2-apply" data-fid="' +
          escapeHtml(String(it.id)) +
          '">Apply</button>';
      }
      if (st === 'active') {
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

  function scheduleInitialReview() {
    if (hasCompletedInitialReview) return;
    if (initialTimer) clearTimeout(initialTimer);
    initialTimer = setTimeout(function () {
      initialTimer = null;
      requestInitialReview();
    }, initialIdleMs);
  }

  function requestInitialReview() {
    if (hasCompletedInitialReview) return;
    runStructuredReview(false);
  }

  function tryIncrementalReview() {
    if (!hasCompletedInitialReview || reviewInFlight) return false;
    var plain = getDraftPlain();
    if (plain.length < MIN_PLAIN_CHARS) return false;
    if (Date.now() - lastReviewAt < MIN_REVIEW_INTERVAL_MS) return false;
    runStructuredReview(true);
    return true;
  }

  function runStructuredReview(isIncremental) {
    if (selectedId == null || !bundle) return;
    if (!quill && !document.getElementById('anvil2-fallback')) return;
    if (reviewInFlight) return;
    var plain = getDraftPlain();
    if (plain.length < MIN_PLAIN_CHARS) return;

    if (!isIncremental) {
      if (plain === lastPlainSent) return;
    }

    var now = Date.now();
    if (now - lastReviewAt < MIN_REVIEW_INTERVAL_MS) return;

    reviewInFlight = true;
    lastReviewAt = now;
    if (!isIncremental) {
      lastPlainSent = plain;
    }

    var html = getDraftHtml();
    var mount = document.getElementById('anvil2-feedback-mount');

    if (isIncremental) {
      setAnalyzeBanner(true, 'Analyzing new text…');
    } else if (mount) {
      mount.innerHTML = '<p class="anvil2-feedback-placeholder">Fetching AI feedback…</p>';
    }

    api('/projects/' + projectId + '/sections/' + selectedId + '/review-structured', 'POST', {
      html: html,
      plainText: plain,
    })
      .then(function (data) {
        var items = (data && data.items) || [];
        if (data && data.skipped && data.shortDraft) {
          if (isIncremental) {
            setAnalyzeBanner(false);
          } else if (mount) {
            mount.innerHTML =
              '<p class="anvil2-feedback-placeholder">Add a bit more text for feedback.</p>';
          }
          return;
        }
        if (isIncremental) {
          appendRowsFromApi(items);
        } else {
          setRowsFromApi(items);
          hasCompletedInitialReview = true;
        }
        charsSinceFingerprint = 0;
        recordTextFingerprint();
      })
      .catch(function (e) {
        if (!isIncremental) {
          lastPlainSent = '';
        }
        if (isIncremental) {
          setAnalyzeBanner(false);
        } else if (mount) {
          mount.innerHTML =
            '<p class="anvil2-feedback-placeholder anvil2-feedback-err" role="alert">' +
            escapeHtml(e.message || 'Request failed') +
            '</p>';
        }
      })
      .then(function () {
        reviewInFlight = false;
        if (isIncremental) {
          setAnalyzeBanner(false);
        }
      });
  }

  function onEditorUserChange(delta) {
    scheduleSave();
    if (!hasCompletedInitialReview) {
      scheduleInitialReview();
      return;
    }
    charsSinceFingerprint += deltaChangeSize(delta);
    if (charsSinceFingerprint >= incrementalChars) {
      if (tryIncrementalReview()) {
        charsSinceFingerprint = 0;
      }
    }
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
        taLastLen = ta.value.length;
        ta.addEventListener('input', function () {
          scheduleSave();
          var cur = ta.value.length;
          var deltaLen = Math.abs(cur - taLastLen);
          taLastLen = cur;
          if (!hasCompletedInitialReview) {
            scheduleInitialReview();
            return;
          }
          charsSinceFingerprint += deltaLen;
          if (charsSinceFingerprint >= incrementalChars) {
            if (tryIncrementalReview()) {
              charsSinceFingerprint = 0;
            }
          }
        });
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
    quill.on('text-change', function (delta, oldDelta, source) {
      if (source === 'silent') {
        scheduleSave();
        return;
      }
      onEditorUserChange(delta);
    });
  }

  function render() {
    if (!bundle) return;
    delete root.dataset.fpChars;
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
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
      '<div id="anvil2-analyze-banner" class="anvil2-analyze-banner" hidden aria-live="polite"></div>' +
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
    hasCompletedInitialReview = false;
    charsSinceFingerprint = 0;
    renderFeedbackRail();
    document.getElementById('anvil2-section-select').addEventListener('change', function (e) {
      selectedId = parseInt(e.target.value, 10);
      render();
    });
  }

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
