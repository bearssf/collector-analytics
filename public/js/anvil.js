/**
 * The Anvil — structured anchor-based feedback (see docs/ai-feedback-system-spec.md).
 * POST /api/.../review-structured (no persistence to anvil_suggestions).
 */
(function () {
  var root = document.getElementById('anvil-root');
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
  var MIN_PLAIN_CHARS = 15;

  var hasCompletedInitialReview = false;
  var charsSinceFingerprint = 0;

  var paperMode = false;

  function recordTextFingerprint() {
    var fp = getDraftPlain();
    root.dataset.fpChars = String(fp.length);
  }
  var reviewInFlight = false;
  var taLastLen = 0;

  var feedbackRows = [];

  /* ── Custom Quill font whitelist ── */
  var Font = Quill.imports['formats/font'];
  Font.whitelist = [
    false,
    'times-new-roman',
    'arial',
    'georgia',
    'courier-new',
    'verdana',
    'garamond',
    'calibri',
    'cambria',
    'helvetica',
  ];
  Quill.register(Font, true);

  /* ── Custom Quill size whitelist ── */
  var Size = Quill.imports['formats/size'];
  Size.whitelist = [
    false,
    '8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '16pt', '18pt', '20pt', '24pt',
  ];
  Quill.register(Size, true);

  /* ── Image resize overlay (viewport-fixed, does not modify Quill DOM) ── */
  var resizeOverlay = null;
  var resizeHandle = null;
  var resizeTarget = null;
  var isDragging = false;

  function createResizeOverlay() {
    if (resizeOverlay) return;
    resizeOverlay = document.createElement('div');
    resizeOverlay.className = 'anvil-img-overlay';
    resizeHandle = document.createElement('div');
    resizeHandle.className = 'anvil-img-resize-handle';
    resizeOverlay.appendChild(resizeHandle);
    document.body.appendChild(resizeOverlay);

    var startX, startW;
    function onDown(e) {
      if (!resizeTarget) return;
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
      startW = resizeTarget.offsetWidth;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    }
    function onMove(e) {
      if (!resizeTarget) return;
      e.preventDefault();
      var cx = e.clientX || (e.touches && e.touches[0].clientX) || 0;
      var newW = Math.max(40, startW + (cx - startX));
      resizeTarget.setAttribute('width', newW);
      resizeTarget.style.width = newW + 'px';
      resizeTarget.style.height = 'auto';
      positionOverlay();
    }
    function onUp() {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      scheduleSave();
    }
    resizeHandle.addEventListener('mousedown', onDown);
    resizeHandle.addEventListener('touchstart', onDown, { passive: false });
  }

  function positionOverlay() {
    if (!resizeOverlay || !resizeTarget) return;
    var r = resizeTarget.getBoundingClientRect();
    resizeOverlay.style.display = 'block';
    resizeOverlay.style.left = r.left + 'px';
    resizeOverlay.style.top = r.top + 'px';
    resizeOverlay.style.width = r.width + 'px';
    resizeOverlay.style.height = r.height + 'px';
  }

  function hideOverlay() {
    if (resizeOverlay) resizeOverlay.style.display = 'none';
    resizeTarget = null;
  }

  function isImgStillVisible() {
    if (!resizeTarget || !quill) return false;
    return quill.root.contains(resizeTarget);
  }

  function onEditorImgClick(e) {
    if (e.target.tagName === 'IMG') {
      e.preventDefault();
      createResizeOverlay();
      resizeTarget = e.target;
      positionOverlay();
    } else if (!isDragging) {
      hideOverlay();
    }
  }

  function attachImageResizeHandlers() {
    if (!quill) return;
    quill.root.addEventListener('click', onEditorImgClick);

    var editorScroller = quill.root;
    editorScroller.addEventListener('scroll', function () {
      if (resizeTarget && !isDragging) {
        if (isImgStillVisible()) positionOverlay();
        else hideOverlay();
      }
    });

    document.addEventListener('click', function (e) {
      if (!quill) return;
      if (isDragging) return;
      if (!quill.root.contains(e.target) && resizeOverlay && !resizeOverlay.contains(e.target)) {
        hideOverlay();
      }
    });
  }

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
    var ta = document.getElementById('anvil-fallback');
    return ta ? String(ta.value).replace(/\n+$/, '') : '';
  }

  function getDraftHtml() {
    if (quill) {
      return quill.root && quill.root.innerHTML ? String(quill.root.innerHTML) : '';
    }
    var ta = document.getElementById('anvil-fallback');
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
    var el = document.getElementById('anvil-analyze-banner');
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
    if (!quill && !document.getElementById('anvil-fallback')) return;
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
    var mount = document.getElementById('anvil-feedback-mount');
    if (!mount) return;
    if (!feedbackRows.length) {
      mount.innerHTML =
        '<p class="anvil2-feedback-placeholder">Feedback and suggestions will appear here as you make progress with your writing.</p>';
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
    if (!quill && !document.getElementById('anvil-fallback')) return;
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
    var mount = document.getElementById('anvil-feedback-mount');

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

  /* ── Paste text color normalization (item p) ── */
  function normalizePastedColors(delta) {
    if (!delta || !delta.ops) return delta;
    for (var i = 0; i < delta.ops.length; i++) {
      var op = delta.ops[i];
      if (op.attributes && op.attributes.color) {
        var c = String(op.attributes.color).toLowerCase().replace(/\s/g, '');
        var isWhitish =
          c === '#ffffff' || c === '#fff' || c === 'white' ||
          c === 'rgb(255,255,255)' || c === 'rgba(255,255,255,1)';
        var isBlackish =
          c === '#000000' || c === '#000' || c === 'black' ||
          c === 'rgb(0,0,0)' || c === 'rgba(0,0,0,1)';
        if (paperMode) {
          if (isWhitish) op.attributes.color = '#000000';
        } else {
          if (isBlackish) op.attributes.color = '#ffffff';
        }
      }
    }
    return delta;
  }

  /* ── Image upload handler ── */
  function imageHandler() {
    var input = document.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', 'image/*');
    input.click();
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var fd = new FormData();
      fd.append('image', file);
      fetch('/api/projects/' + projectId + '/anvil/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.url && quill) {
            var range = quill.getSelection(true);
            quill.insertEmbed(range.index, 'image', data.url, 'user');
            quill.setSelection(range.index + 1);
          }
        })
        .catch(function () {
          /* silently fail */
        });
    };
  }

  function mountEditor(rawDraft) {
    var wrap = document.getElementById('anvil-quill-wrap');
    var host = document.getElementById('anvil-editor');
    if (!wrap || !host) return;
    quill = null;
    var draftStr = rawDraft != null && String(rawDraft).trim() ? String(rawDraft) : '';
    if (typeof Quill === 'undefined') {
      wrap.innerHTML =
        '<textarea id="anvil-fallback" class="anvil-textarea" rows="16"></textarea>';
      var ta = document.getElementById('anvil-fallback');
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
    quill = new Quill('#anvil-editor', {
      theme: 'snow',
      modules: {
        toolbar: {
          container: [
            [{ font: Font.whitelist }],
            [{ size: Size.whitelist }],
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ color: [] }, { background: [] }],
            [{ list: 'ordered' }, { list: 'bullet' }],
            [{ indent: '-1' }, { indent: '+1' }],
            [{ align: [] }],
            ['blockquote'],
            ['link', 'image'],
            ['clean'],
          ],
          handlers: {
            image: imageHandler,
          },
        },
        clipboard: {
          matchers: [],
        },
      },
      placeholder: 'Write here — feedback loads after you pause typing.',
    });

    quill.clipboard.addMatcher(Node.ELEMENT_NODE, function (node, delta) {
      return normalizePastedColors(delta);
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

    if (paperMode) {
      wrap.classList.add('anvil-quill-wrap--paper');
    }

    setTimeout(attachImageResizeHandlers, 200);
  }

  /* ── Paper (light) / Dark mode toggle ── */
  function togglePaperMode() {
    paperMode = !paperMode;
    var wrap = document.getElementById('anvil-quill-wrap');
    var btn = document.getElementById('anvil-paper-toggle');
    if (wrap) {
      if (paperMode) {
        wrap.classList.add('anvil-quill-wrap--paper');
      } else {
        wrap.classList.remove('anvil-quill-wrap--paper');
      }
    }
    if (btn) {
      btn.setAttribute('aria-checked', paperMode ? 'true' : 'false');
      var hint = document.getElementById('anvil-paper-hint');
      if (hint) hint.textContent = paperMode ? 'LIGHT MODE' : 'DARK MODE';
    }
    try {
      localStorage.setItem('anvil-paper-mode', paperMode ? '1' : '0');
    } catch (e) { /* ignore */ }
  }

  function loadPaperPref() {
    try {
      var v = localStorage.getItem('anvil-paper-mode');
      if (v === '1') paperMode = true;
    } catch (e) { /* ignore */ }
  }

  /* ── Writing style profiles (citation style → formatting) ── */
  var STYLE_PROFILES = {
    APA: { font: 'times-new-roman', size: '12pt', lineHeight: '2', indent: '0.5in' },
    MLA: { font: 'times-new-roman', size: '12pt', lineHeight: '2', indent: '0.5in' },
    Chicago: { font: 'times-new-roman', size: '12pt', lineHeight: '2', indent: '0.5in' },
    Turabian: { font: 'times-new-roman', size: '12pt', lineHeight: '2', indent: '0.5in' },
    IEEE: { font: 'times-new-roman', size: '10pt', lineHeight: '1.15', indent: '0' },
  };

  function getProjectCitationStyle() {
    if (!bundle || !bundle.project) return 'APA';
    return bundle.project.citation_style || bundle.project.citationStyle || 'APA';
  }

  function applyWritingStyle() {
    if (!quill) return;
    var style = getProjectCitationStyle();
    var prof = STYLE_PROFILES[style] || STYLE_PROFILES.APA;
    var wrap = document.getElementById('anvil-quill-wrap');
    if (wrap) {
      wrap.classList.add('anvil-quill-manuscript');
      if (style === 'IEEE') {
        wrap.setAttribute('data-ms-profile', 'ieee');
      } else {
        wrap.removeAttribute('data-ms-profile');
      }
    }
    var len = quill.getLength();
    if (len > 1) {
      quill.formatText(0, len, 'font', prof.font, 'silent');
      quill.formatText(0, len, 'size', prof.size, 'silent');
    }
    scheduleSave();
  }

  /* ── Export helpers ── */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function htmlToRtf(html) {
    var container = document.createElement('div');
    container.innerHTML = html;
    var text = container.innerText || container.textContent || '';
    var rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}' +
      '\\f0\\fs24 ';
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}');
      rtf += line;
      if (i < lines.length - 1) rtf += '\\par\n';
    }
    rtf += '}';
    return rtf;
  }

  function exportSectionRtf() {
    if (selectedId == null) return;
    var sec = sectionById(selectedId);
    var html = getDraftHtml();
    var rtf = htmlToRtf(html);
    var blob = new Blob([rtf], { type: 'application/rtf' });
    var name = (sec ? sec.title : 'Section') + '.rtf';
    downloadBlob(blob, name);
  }

  function exportSectionDocx() {
    if (selectedId == null) return;
    var sec = sectionById(selectedId);
    var html = getDraftHtml();
    var title = sec ? sec.title : 'Section';
    fetch('/api/projects/' + projectId + '/sections/' + selectedId + '/export-docx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: html, title: title }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Export failed');
        return r.blob();
      })
      .then(function (blob) {
        downloadBlob(blob, title + '.docx');
      })
      .catch(function () { /* silently fail */ });
  }

  function exportAllRtf() {
    if (!bundle || !bundle.sections) return;
    var combined = '';
    bundle.sections.forEach(function (sec) {
      combined += '<h2>' + escapeHtml(sec.title) + '</h2>';
      combined += (sec.body || '') + '\n';
    });
    var rtf = htmlToRtf(combined);
    var blob = new Blob([rtf], { type: 'application/rtf' });
    var name = (bundle.project ? bundle.project.name : 'Project') + '.rtf';
    downloadBlob(blob, name);
  }

  function exportAllDocx() {
    if (!bundle || !bundle.sections) return;
    var sections = bundle.sections.map(function (s) {
      return { title: s.title, body: s.body || '' };
    });
    fetch('/api/projects/' + projectId + '/export-project-docx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: sections }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Export failed');
        return r.blob();
      })
      .then(function (blob) {
        var name = (bundle.project ? bundle.project.name : 'Project') + '.docx';
        downloadBlob(blob, name);
      })
      .catch(function () { /* silently fail */ });
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
        '<div class="anvil-panel--writing"><p class="anvil-muted">No sections in this project.</p></div>';
      return;
    }
    if (selectedId == null) selectedId = Number(sections[0].id);
    var current = sectionById(selectedId);
    if (!current && sections.length) {
      selectedId = Number(sections[0].id);
      current = sectionById(selectedId);
    }
    var draft = sectionBodyProp(current);

    var citStyle = getProjectCitationStyle();

    root.innerHTML =
      '<div class="anvil-panel--writing">' +
      '<div class="anvil-layout--single">' +
      '<div id="anvil-analyze-banner" class="anvil-analyze-banner" hidden aria-live="polite"></div>' +
      '<div class="anvil-editor">' +
      '<div id="anvil-quill-wrap" class="anvil-quill-wrap"><div id="anvil-editor" class="anvil-quill"></div></div>' +
      '<div class="anvil-editor-footer">' +
      '<div class="anvil-editor-footer__left"></div>' +
      '<div class="anvil-editor-footer__mid">' +
      '<div class="anvil-paper-toggle-wrap">' +
      '<button type="button" id="anvil-paper-toggle" class="anvil-paper-toggle" role="switch" aria-checked="' + (paperMode ? 'true' : 'false') + '" title="Toggle light/dark writing mode">' +
      '<span class="anvil-paper-toggle__track"><span class="anvil-paper-toggle__thumb"></span></span>' +
      '</button>' +
      '<span id="anvil-paper-hint" class="anvil-paper-toggle__hint">' + (paperMode ? 'LIGHT MODE' : 'DARK MODE') + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="anvil-editor-footer__right"></div>' +
      '</div>' +
      '</div>' +
      '<div class="anvil-export-bar">' +
      '<div class="anvil-export-bar__row">' +
      '<span class="anvil-export-label">Actions</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-apply-style">Apply ' + escapeHtml(citStyle) + ' style</button>' +
      '<span class="anvil-export-sep">|</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-rtf">Export Section (RTF)</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-docx">Export Section (Word)</button>' +
      '<span class="anvil-export-sep">|</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-all-rtf">Export Document (RTF)</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-all-docx">Export Document (Word)</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>';

    mountEditor(draft);
    feedbackRows = [];
    lastPlainSent = '';
    hasCompletedInitialReview = false;
    charsSinceFingerprint = 0;
    renderFeedbackRail();

    document.getElementById('anvil-paper-toggle').addEventListener('click', togglePaperMode);
    document.getElementById('anvil-apply-style').addEventListener('click', applyWritingStyle);
    document.getElementById('anvil-export-section-rtf').addEventListener('click', exportSectionRtf);
    document.getElementById('anvil-export-section-docx').addEventListener('click', exportSectionDocx);
    document.getElementById('anvil-export-all-rtf').addEventListener('click', exportAllRtf);
    document.getElementById('anvil-export-all-docx').addEventListener('click', exportAllDocx);

    /* Highlight the active section in sidebar */
    var sidebarSectionLinks = document.querySelectorAll('.app-nav--anvil-sections a');
    sidebarSectionLinks.forEach(function (link) {
      var href = link.getAttribute('href') || '';
      var match = href.match(/[?&]section=(\d+)/);
      if (match) {
        var linkSid = parseInt(match[1], 10);
        if (linkSid === selectedId) {
          link.classList.add('active');
        } else {
          link.classList.remove('active');
        }
      }
    });
  }

  /* Listen for sidebar section clicks to navigate without full page reload */
  document.addEventListener('click', function (e) {
    var sectionLink = e.target.closest('.app-nav--anvil-sections a');
    if (sectionLink && bundle) {
      var href = sectionLink.getAttribute('href') || '';
      var match = href.match(/[?&]section=(\d+)/);
      if (match) {
        e.preventDefault();
        var sid = parseInt(match[1], 10);
        if (!Number.isNaN(sid) && bundle.sections && bundle.sections.some(function (s) { return Number(s.id) === sid; })) {
          selectedId = sid;
          history.replaceState(null, '', href);
          render();
        }
      }
    }
  });

  document.addEventListener('click', function (e) {
    if (!document.getElementById('anvil-root')) return;
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
    loadPaperPref();
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
