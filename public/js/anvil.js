/**
 * The Anvil — rich text (Quill) with autosave; body stored as Quill Delta JSON (or legacy HTML).
 * Delta avoids HTML↔clipboard round-trip loss (fonts, sizes, bold, etc.). Export still uses HTML.
 */
(function () {
  const root = document.getElementById('anvil-root');
  if (!root) return;

  const projectId = parseInt(root.dataset.projectId, 10);
  if (Number.isNaN(projectId)) return;

  let bundle = null;
  let selectedId = null;
  let debounceTimer = null;
  const DEBOUNCE_MS = 900;
  let reviewTimer = null;
  const REVIEW_DEBOUNCE_MS = 4500;
  const MIN_REVIEW_INTERVAL_MS = 28000;
  let lastReviewContentHash = '';
  let lastReviewAt = 0;
  let bedrockReviewDisabled = false;
  let aiReviewHintTimer = null;
  let anvilSources = [];
  let anvilSourcesError = null;
  let quillEditor = null;
  var exportQuillInstance = null;
  var anvilQuillFormatsRegistered = false;

  let feedbackPreviewActive = false;
  let feedbackPreviewSnapshotHtml = '';
  let feedbackPreviewSuggestionId = null;
  var anvilCitationBlotRegistered = false;
  /** Last fetched suggestions for the current section (used for Evidence actions). */
  var lastFeedbackSuggestions = [];
  var evidenceResolveSuggestionId = null;

  const PAPER_PREF_KEY = 'af.anvil.paper';

  var ANVIL_QUILL_FONTS = [
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
  var ANVIL_QUILL_SIZES = ['8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '16pt', '18pt', '20pt', '24pt'];

  function registerAnvilQuillFormatsOnce() {
    if (typeof Quill === 'undefined') return;
    if (!anvilQuillFormatsRegistered) {
      try {
        var Font = Quill.import('formats/font');
        Font.whitelist = ANVIL_QUILL_FONTS;
        try {
          var FontClassPath = Quill.import('attributors/class/font');
          if (FontClassPath && FontClassPath !== Font) {
            FontClassPath.whitelist = ANVIL_QUILL_FONTS;
          }
        } catch (e2) {
          /* ignore */
        }
        Quill.register(Font, true);
      } catch (e) {
        /* ignore */
      }
      try {
        var SizeStyle = Quill.import('attributors/style/size');
        SizeStyle.whitelist = ANVIL_QUILL_SIZES;
        Quill.register(SizeStyle, true);
      } catch (e) {
        /* ignore */
      }
      anvilQuillFormatsRegistered = true;
    }
    if (!anvilCitationBlotRegistered) {
      try {
        var Inline = Quill.import('blots/inline');
        function AnvilCitationBlot() {
          Inline.apply(this, arguments);
        }
        AnvilCitationBlot.prototype = Object.create(Inline.prototype);
        AnvilCitationBlot.prototype.constructor = AnvilCitationBlot;
        AnvilCitationBlot.blotName = 'anvilCitation';
        AnvilCitationBlot.tagName = 'span';
        AnvilCitationBlot.className = 'anvil-cite';
        AnvilCitationBlot.create = function (value) {
          var node = Inline.create.call(AnvilCitationBlot);
          if (value != null && value !== true) {
            node.setAttribute('data-source-id', String(value));
          }
          return node;
        };
        AnvilCitationBlot.formats = function (domNode) {
          return domNode.getAttribute('data-source-id');
        };
        Quill.register(AnvilCitationBlot, true);
        anvilCitationBlotRegistered = true;
      } catch (e) {
        /* ignore */
      }
    }
  }

  function sectionBodyProp(sec) {
    if (!sec) return '';
    if (sec.body != null) return String(sec.body);
    if (sec.Body != null) return String(sec.Body);
    return '';
  }

  function isQuillDeltaJson(s) {
    var t = String(s || '').trim();
    return t.length > 0 && t.charAt(0) === '{' && /"ops"\s*:\s*\[/.test(t);
  }

  function isAnvilMsHtmlJson(s) {
    var t = String(s || '').trim();
    if (t.length === 0 || t.charAt(0) !== '{') return false;
    try {
      var o = JSON.parse(t);
      return !!(o && o._anvil === 'mshtml' && o.html != null);
    } catch (e) {
      return false;
    }
  }

  function storageIsEffectivelyEmpty(s) {
    if (s == null || !String(s).trim()) return true;
    var t = String(s).trim();
    if (isAnvilMsHtmlJson(t)) {
      try {
        var mo = JSON.parse(t);
        return htmlIsEffectivelyEmpty(String(mo.html || ''));
      } catch (e) {
        return true;
      }
    }
    if (isQuillDeltaJson(t)) {
      try {
        var o = JSON.parse(t);
        if (!o.ops || !o.ops.length) return true;
        if (
          o.ops.length === 1 &&
          typeof o.ops[0].insert === 'string' &&
          o.ops[0].insert === '\n' &&
          !o.ops[0].attributes
        ) {
          return true;
        }
        return false;
      } catch (e) {
        return true;
      }
    }
    return htmlIsEffectivelyEmpty(t);
  }

  function normalizeStorageCompare(s) {
    if (storageIsEffectivelyEmpty(s)) return '';
    return String(s).trim();
  }

  function getExportQuill() {
    if (exportQuillInstance) return exportQuillInstance;
    if (typeof Quill === 'undefined') return null;
    registerAnvilQuillFormatsOnce();
    var host = document.createElement('div');
    host.id = 'anvil-export-quill-host';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;left:-99999px;top:0;width:720px;height:400px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
    host.innerHTML = '<div class="anvil-quill-wrap"><div id="anvil-export-quill-inner"></div></div>';
    document.body.appendChild(host);
    exportQuillInstance = new Quill('#anvil-export-quill-inner', {
      theme: 'snow',
      modules: { toolbar: false },
    });
    return exportQuillInstance;
  }

  function deltaJsonToHtml(jsonStr) {
    try {
      var parsed = JSON.parse(jsonStr);
      if (parsed && parsed._anvil === 'mshtml' && parsed.html != null) {
        return String(parsed.html);
      }
    } catch (e) {}
    var Delta = Quill.import('delta');
    var q = getExportQuill();
    if (!q) return '';
    q.setContents(new Delta(JSON.parse(jsonStr)), 'silent');
    return q.root.innerHTML;
  }

  /** HTML for export / plain-text extraction (handles Delta JSON or legacy HTML). */
  function sectionBodyToHtml(raw) {
    if (raw == null || !String(raw).trim()) return '';
    var s = String(raw).trim();
    if (isAnvilMsHtmlJson(s)) {
      try {
        var ms = JSON.parse(s);
        return bodyToHtml(String(ms.html || ''));
      } catch (e) {
        return '';
      }
    }
    if (isQuillDeltaJson(s)) {
      try {
        return deltaJsonToHtml(s);
      } catch (e) {
        return '';
      }
    }
    return bodyToHtml(s);
  }

  function getEditorBodyForSave() {
    if (quillEditor) {
      if (shouldSaveManuscriptHtml()) {
        var pk = currentManuscriptProfileKeyForSave();
        return JSON.stringify({
          _anvil: 'mshtml',
          v: 1,
          profile: pk,
          html: getEditorHtml(),
        });
      }
      return JSON.stringify(quillEditor.getContents());
    }
    var ta = document.getElementById('anvil-body');
    if (ta && ta.tagName === 'TEXTAREA') {
      return bodyToHtml(ta.value);
    }
    return '';
  }

  function applyInitialEditorContent(raw) {
    if (!quillEditor) return;
    var s = raw != null ? String(raw).trim() : '';
    if (!s) {
      setQuillHtml('');
      return;
    }
    if (s.charAt(0) === '{') {
      try {
        var mobj = JSON.parse(s);
        if (mobj && mobj._anvil === 'mshtml' && mobj.html != null) {
          var pk = mobj.profile || 'APA';
          var fullMs = quillEditor.getLength();
          quillEditor.deleteText(0, fullMs, 'silent');
          quillEditor.clipboard.dangerouslyPasteHTML(0, normalizeQuillLoadHtml(String(mobj.html)), 'silent');
          var wrapMs = document.getElementById('anvil-quill-wrap');
          writeManuscriptPref(selectedId, { enabled: true, profile: pk });
          applyManuscriptChrome(wrapMs, quillEditor, pk);
          return;
        }
        if (mobj && mobj.ops) {
          var DeltaJson = Quill.import('delta');
          quillEditor.setContents(new DeltaJson(mobj), 'silent');
          restoreManuscriptPrefAfterDeltaLoad();
          return;
        }
      } catch (eMs) {
        /* fall through */
      }
    }
    if (isQuillDeltaJson(s)) {
      try {
        var Delta = Quill.import('delta');
        quillEditor.setContents(new Delta(JSON.parse(s)), 'silent');
        restoreManuscriptPrefAfterDeltaLoad();
        return;
      } catch (e) {
        /* fall through to HTML */
      }
    }
    writeManuscriptPref(selectedId, null);
    setQuillHtml(bodyToHtml(s));
  }

  function buildAnvilImageUploadHandler() {
    return function anvilImageHandler() {
      var input = document.createElement('input');
      input.setAttribute('type', 'file');
      input.setAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp');
      input.click();
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          alert('Image must be 5 MB or smaller.');
          return;
        }
        var fd = new FormData();
        fd.append('image', file);
        fetch('/api/projects/' + projectId + '/anvil/upload', {
          method: 'POST',
          body: fd,
          credentials: 'same-origin',
        })
          .then(function (res) {
            return res.json().then(function (data) {
              if (!res.ok) throw new Error((data && data.error) || 'Upload failed');
              return data.url;
            });
          })
          .then(function (url) {
            if (!quillEditor || !url) return;
            var range = quillEditor.getSelection(true);
            var idx = range ? range.index : quillEditor.getLength();
            quillEditor.insertEmbed(idx, 'image', url, 'user');
            quillEditor.setSelection(idx + 1, 0);
            scheduleSave();
          })
          .catch(function (err) {
            alert(err.message || 'Could not upload image.');
          });
      };
    };
  }

  function readPaperPreference() {
    try {
      return localStorage.getItem(PAPER_PREF_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function writePaperPreference(on) {
    try {
      if (on) localStorage.setItem(PAPER_PREF_KEY, '1');
      else localStorage.removeItem(PAPER_PREF_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function applyPaperToEditor(on) {
    var wrap = document.getElementById('anvil-quill-wrap');
    var btn = document.getElementById('anvil-paper-toggle');
    var hint = document.getElementById('anvil-paper-toggle-hint');
    if (wrap) wrap.classList.toggle('anvil-quill-wrap--paper', on);
    if (btn) {
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.setAttribute(
        'aria-label',
        on
          ? 'Light mode on. Switch to dark mode writing area.'
          : 'Dark mode on. Switch to light mode writing area.'
      );
    }
    if (hint) {
      hint.textContent = on ? 'Dark mode' : 'Light mode';
    }
  }

  function bindPaperToggle() {
    var btn = document.getElementById('anvil-paper-toggle');
    if (!btn) return;
    var on = readPaperPreference();
    applyPaperToEditor(on);
    btn.addEventListener('click', function () {
      var next = !readPaperPreference();
      writePaperPreference(next);
      applyPaperToEditor(next);
    });
  }

  function htmlToPlainLinesClient(html) {
    if (html == null || !String(html).trim()) return [];
    var s = String(html);
    s = s.replace(/<\/p>/gi, '\n');
    s = s.replace(/<\/li>/gi, '\n');
    s = s.replace(/<\/h[1-6][^>]*>/gi, '\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/g, ' ');
    s = s.replace(/&amp;/g, '&');
    s = s.replace(/&lt;/g, '<');
    s = s.replace(/&gt;/g, '>');
    s = s.replace(/&#39;/g, "'");
    s = s.replace(/&quot;/g, '"');
    return s
      .split(/\n+/)
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
  }

  function clientSanitizeFilename(name) {
    var base = String(name || 'export')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return base || 'export';
  }

  function downloadBlob(filename, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  async function apiPostDocx(path, jsonBody) {
    var res = await fetch('/api' + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonBody),
    });
    if (!res.ok) {
      var errText = await res.text();
      var msg = errText;
      try {
        var j = JSON.parse(errText);
        if (j && j.error) msg = j.error;
      } catch (e) {
        /* ignore */
      }
      throw new Error(msg || 'Request failed');
    }
    return res.blob();
  }

  async function api(path, method, body, extraFetchOpts) {
    const opts = Object.assign(
      {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      },
      extraFetchOpts || {}
    );
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

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function doiLandingPageUrl(doi) {
    if (doi == null || String(doi).trim() === '') return null;
    const d = String(doi).trim();
    return 'https://doi.org/' + encodeURIComponent(d).replace(/%2F/g, '/');
  }

  /** Migrate legacy plain-text bodies to HTML paragraphs; leave existing HTML as-is. */
  function bodyToHtml(raw) {
    if (raw == null || raw === '') return '';
    const s = String(raw);
    const t = s.trim();
    if (t.startsWith('<') && /[a-zA-Z\/]/.test(t.slice(0, 20))) {
      return s;
    }
    if (!t) return '';
    const escaped = escapeHtml(s);
    return '<p>' + escaped.replace(/\r\n|\r|\n/g, '</p><p>') + '</p>';
  }

  function plainTextFromBody(raw) {
    if (raw == null || raw === '') return '';
    const s = String(raw);
    const t = s.trim();
    if (t.startsWith('<')) {
      const d = document.createElement('div');
      d.innerHTML = s;
      return (d.textContent || d.innerText || '').replace(/\u00a0/g, ' ');
    }
    return s;
  }

  function htmlIsEffectivelyEmpty(html) {
    if (html == null || html === '') return true;
    const t = String(html)
      .replace(/\s|&nbsp;/g, '')
      .replace(/<p><br\s*\/?><\/p>/gi, '')
      .replace(/<br\s*\/?>/gi, '');
    return t === '' || t === '<p></p>';
  }

  function normalizeForCompare(html) {
    return htmlIsEffectivelyEmpty(html) ? '' : String(html);
  }

  /**
   * Quill's Image blot reads dimensions from width/height attributes only (not CSS style).
   * The image-resize module stores size in style — copy px values to attributes before
   * clipboard.convert so dimensions survive reload.
   */
  function normalizeQuillLoadHtml(html) {
    if (html == null || !String(html).trim()) return html;
    try {
      var d = document.createElement('div');
      d.innerHTML = String(html);
      d.querySelectorAll('img').forEach(function (img) {
        var wAttr = img.getAttribute('width');
        var hAttr = img.getAttribute('height');
        var sw = img.style && img.style.width;
        var sh = img.style && img.style.height;
        if (!wAttr && sw) {
          var wm = sw.trim().match(/^(\d+(?:\.\d+)?)px$/i);
          if (wm) img.setAttribute('width', String(Math.round(parseFloat(wm[1]))));
        }
        if (!hAttr && sh && !/^auto$/i.test(sh.trim())) {
          var hm = sh.trim().match(/^(\d+(?:\.\d+)?)px$/i);
          if (hm) img.setAttribute('height', String(Math.round(parseFloat(hm[1]))));
        }
      });
      return d.innerHTML;
    } catch (e) {
      return html;
    }
  }

  function simpleContentHash(str) {
    var h = 5381;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return String(h);
  }

  function setAiReviewHint(msg) {
    var el = document.getElementById('anvil-ai-review-hint');
    if (!el) return;
    if (aiReviewHintTimer) {
      clearTimeout(aiReviewHintTimer);
      aiReviewHintTimer = null;
    }
    if (!msg) {
      el.textContent = '';
      el.hidden = true;
      return;
    }
    el.textContent = msg;
    el.hidden = false;
    aiReviewHintTimer = setTimeout(function () {
      el.textContent = '';
      el.hidden = true;
      aiReviewHintTimer = null;
    }, 14000);
  }

  function scheduleAiReview() {
    if (bedrockReviewDisabled) return;
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = setTimeout(function () {
      reviewTimer = null;
      runAiReview();
    }, REVIEW_DEBOUNCE_MS);
  }

  async function runAiReview() {
    if (feedbackPreviewActive || bedrockReviewDisabled || selectedId == null || bundle == null) return;
    var html = getEditorHtml();
    if (htmlIsEffectivelyEmpty(html)) return;
    var norm = normalizeForCompare(html);
    var hash = simpleContentHash(norm);
    if (hash === lastReviewContentHash) return;
    if (Date.now() - lastReviewAt < MIN_REVIEW_INTERVAL_MS) return;
    try {
      var data = await api('/projects/' + projectId + '/sections/' + selectedId + '/review', 'POST', { html: html });
      if (data && data.shortDraft) {
        setAiReviewHint('Write a little more — AI review runs after you have at least a short paragraph.');
        await renderFeedbackRail();
        updateProgressBar();
        return;
      }
      lastReviewContentHash = hash;
      lastReviewAt = Date.now();
      if (data && data.inserted === 0 && !data.skipped) {
        setAiReviewHint('No suggestions this round — the model may not see issues, or try adding more detail.');
      }
      await renderFeedbackRail();
      updateProgressBar();
    } catch (e) {
      var m = e && e.message ? String(e.message) : '';
      if (/not configured/i.test(m)) {
        bedrockReviewDisabled = true;
        setAiReviewHint('AI review is not configured (set AWS_REGION, BEDROCK_MODEL_ID, and IAM keys on the server).');
      } else {
        setAiReviewHint(m.slice(0, 220));
      }
    }
  }

  function getEditorHtml() {
    if (quillEditor) {
      return quillEditor.root.innerHTML;
    }
    const ta = document.getElementById('anvil-body');
    if (ta && ta.tagName === 'TEXTAREA') {
      return bodyToHtml(ta.value);
    }
    return '';
  }

  function setQuillHtml(html) {
    if (!quillEditor) return;
    const raw = html && String(html).trim() ? String(html) : '<p><br></p>';
    const h = normalizeQuillLoadHtml(raw);
    try {
      const delta = quillEditor.clipboard.convert(h);
      quillEditor.setContents(delta, 'silent');
    } catch (e) {
      quillEditor.setText('');
    }
  }

  function replaceEditorHtml(html) {
    if (!quillEditor) return;
    const raw = html && String(html).trim() ? String(html) : '<p><br></p>';
    const fullLen = quillEditor.getLength();
    quillEditor.deleteText(0, fullLen, 'silent');
    quillEditor.clipboard.dangerouslyPasteHTML(0, normalizeQuillLoadHtml(raw), 'silent');
  }

  function afterExternalHtmlReplace() {
    if (!quillEditor || selectedId == null) return;
    var wrap = document.getElementById('anvil-quill-wrap');
    if (!wrap || !wrap.classList.contains('anvil-quill-manuscript')) return;
    var pref = readManuscriptPref(selectedId);
    var profile = pref && pref.profile ? pref.profile : wrap.getAttribute('data-ms-profile') || projectCitationStyle();
    applyManuscriptChrome(wrap, quillEditor, profile);
    applyManuscriptStylesToDom(quillEditor.root, projectCitationStyle(), readPaperPreference());
  }

  /** Remove pasted inline colors so text inherits the dark or light editor theme. */
  function stripInlineColorFromPasteNode(node) {
    if (!node || node.nodeType !== 1) return;
    var el = node;
    if (el.tagName === 'FONT') {
      el.removeAttribute('color');
    }
    if (el.style) {
      el.style.removeProperty('color');
    }
  }

  function deltaStripColorAttrs(delta) {
    var Delta = typeof Quill !== 'undefined' ? Quill.import('delta') : null;
    if (!Delta || !delta || !delta.ops) return delta;
    var next = new Delta();
    delta.ops.forEach(function (op) {
      if (op.insert != null) {
        if (typeof op.insert === 'string' && op.attributes) {
          var a = Object.assign({}, op.attributes);
          delete a.color;
          delete a.background;
          if (Object.keys(a).length === 0) {
            next.insert(op.insert);
          } else {
            next.insert(op.insert, a);
          }
        } else {
          next.insert(op.insert, op.attributes);
        }
      } else if (op.retain != null) {
        var ra = op.attributes;
        if (ra) {
          var ra2 = Object.assign({}, ra);
          delete ra2.color;
          delete ra2.background;
          if (Object.keys(ra2).length === 0) {
            next.retain(op.retain);
          } else {
            next.retain(op.retain, ra2);
          }
        } else {
          next.retain(op.retain);
        }
      } else if (op.delete) {
        next.delete(op.delete);
      }
    });
    return next;
  }

  function installQuillPasteColorNormalization(quill) {
    if (!quill || !quill.clipboard) return;
    quill.clipboard.addMatcher(Node.ELEMENT_NODE, function (node, delta) {
      stripInlineColorFromPasteNode(node);
      return deltaStripColorAttrs(delta);
    });
  }

  function mountEditor(rawDraft) {
    quillEditor = null;
    const wrap = document.getElementById('anvil-quill-wrap');
    const host = document.getElementById('anvil-editor');
    if (!wrap || !host) return;

    const draftStr = rawDraft != null && String(rawDraft).trim() ? String(rawDraft) : '';

    if (typeof Quill !== 'undefined') {
      registerAnvilQuillFormatsOnce();
      var quillModules = {
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            [{ font: ANVIL_QUILL_FONTS }, { size: ANVIL_QUILL_SIZES }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            [{ indent: '-1' }, { indent: '+1' }],
            ['link', 'image'],
            ['clean'],
          ],
          handlers: {
            image: buildAnvilImageUploadHandler(),
          },
        },
      };
      try {
        if (Quill.import('modules/imageResize')) {
          quillModules.imageResize = {
            modules: ['Resize', 'DisplaySize', 'Toolbar'],
            overlayStyles: {
              position: 'absolute',
              boxSizing: 'border-box',
              border: '1px dashed rgba(47, 128, 237, 0.85)',
              zIndex: '5',
            },
            handleStyles: {
              position: 'absolute',
              height: '12px',
              width: '12px',
              backgroundColor: 'rgba(22, 28, 36, 0.96)',
              border: '1px solid rgba(255, 255, 255, 0.4)',
              boxSizing: 'border-box',
              borderRadius: '2px',
              opacity: '1',
            },
            displayStyles: {
              position: 'absolute',
              font: '12px/1.2 system-ui, -apple-system, sans-serif',
              padding: '4px 8px',
              textAlign: 'center',
              backgroundColor: 'rgba(22, 28, 36, 0.96)',
              color: 'rgba(255, 255, 255, 0.92)',
              border: '1px solid rgba(255, 255, 255, 0.22)',
              boxSizing: 'border-box',
              borderRadius: '4px',
              opacity: '1',
              cursor: 'default',
            },
            toolbarStyles: {
              position: 'absolute',
              top: '-12px',
              right: '0',
              left: '0',
              height: '0',
              minWidth: '100px',
              font: '12px/1.2 system-ui, sans-serif',
              textAlign: 'center',
              color: 'rgba(255, 255, 255, 0.9)',
              boxSizing: 'border-box',
              cursor: 'default',
            },
            toolbarButtonStyles: {
              display: 'inline-block',
              width: '24px',
              height: '24px',
              background: 'rgba(22, 28, 36, 0.96)',
              border: '1px solid rgba(255, 255, 255, 0.28)',
              borderRadius: '4px',
              verticalAlign: 'middle',
            },
            toolbarButtonSvgStyles: {
              fill: 'rgba(255, 255, 255, 0.8)',
              stroke: 'rgba(255, 255, 255, 0.8)',
              strokeWidth: '2',
            },
          };
        }
      } catch (e) {
        /* image resize module not loaded */
      }
      quillEditor = new Quill('#anvil-editor', {
        theme: 'snow',
        modules: quillModules,
        placeholder: 'Write your draft here…',
      });
      installQuillPasteColorNormalization(quillEditor);
      applyInitialEditorContent(draftStr);
      setTimeout(function () {
        refreshAnvilCitationsInEditor();
      }, 0);
      quillEditor.on('text-change', function () {
        scheduleSave();
        scheduleAiReview();
        updateProgressBar();
      });
      return;
    }

    wrap.innerHTML =
      '<textarea id="anvil-body" class="anvil-textarea" rows="18" spellcheck="true" placeholder="Write your draft here. Autosaves after you pause typing."></textarea>';
    const ta = document.getElementById('anvil-body');
    if (ta) {
      ta.value = plainTextFromBody(draftStr ? sectionBodyToHtml(draftStr) : '');
      ta.addEventListener('input', function () {
        scheduleSave();
        scheduleAiReview();
        updateProgressBar();
      });
      ta.addEventListener('blur', function () {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        saveDraft('manual');
      });
    }
  }

  function sectionById(id) {
    if (!bundle || !bundle.sections) return null;
    const n = Number(id);
    return bundle.sections.find(function (s) {
      return Number(s.id) === n;
    });
  }

  function referencesSectionId() {
    const secs = bundle && bundle.sections;
    if (!secs || !secs.length) return null;
    for (let i = 0; i < secs.length; i += 1) {
      const s = secs[i];
      const slug = String(s.slug || '').toLowerCase();
      const title = String(s.title || '').trim().toLowerCase();
      if (
        slug === 'references' ||
        slug === 'works-cited' ||
        slug === 'bibliography' ||
        title === 'references' ||
        title === 'works cited' ||
        title === 'bibliography'
      ) {
        return s.id;
      }
    }
    return null;
  }

  function sourcesLinkedToSection(sectionId) {
    const sid = Number(sectionId);
    return (anvilSources || []).filter(function (src) {
      const ids = src.sectionIds || [];
      return ids.some(function (x) {
        return Number(x) === sid;
      });
    });
  }

  /** Same order as the citations rail (for IEEE [n] indices). */
  function linkedSourcesSortedForSection(sectionId) {
    const linked = sourcesLinkedToSection(sectionId);
    return linked.slice().sort(function (a, b) {
      return String(a.citation_text || '').localeCompare(String(b.citation_text || ''), undefined, {
        sensitivity: 'base',
      });
    });
  }

  function ieeeIndexForSourceInSection(sourceId) {
    if (selectedId == null) return 1;
    const list = linkedSourcesSortedForSection(selectedId);
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(sourceId)) return i + 1;
    }
    return 1;
  }

  function projectCitationStyle() {
    if (!bundle || !bundle.project) return 'APA';
    const p = bundle.project;
    const raw = p.citation_style != null ? p.citation_style : p.citationStyle;
    const s = raw != null ? String(raw).trim() : '';
    return s || 'APA';
  }

  var MS_TNR = '"Times New Roman", Times, serif';

  var MANUSCRIPT_PROFILES = {
    APA: {
      body: {
        fontFamily: MS_TNR,
        fontSize: '12pt',
        lineHeight: '2',
        paragraphMargin: '0',
        textIndent: '0.5in',
        textAlign: 'left',
      },
      h1: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'center',
        lineHeight: '2',
        margin: '0.5em 0 0.5em 0',
      },
      h2: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      h3: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'italic',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      h4: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      list: { paddingLeft: '2.5em' },
    },
    MLA: {
      body: {
        fontFamily: MS_TNR,
        fontSize: '12pt',
        lineHeight: '2',
        paragraphMargin: '0',
        textIndent: '0.5in',
        textAlign: 'left',
      },
      h1: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'center',
        lineHeight: '2',
        margin: '0.5em 0 0.5em 0',
      },
      h2: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      h3: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'italic',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      h4: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      list: { paddingLeft: '2.5em' },
    },
    CHICAGO: {
      body: {
        fontFamily: MS_TNR,
        fontSize: '12pt',
        lineHeight: '2',
        paragraphMargin: '0',
        textIndent: '0.5in',
        textAlign: 'left',
      },
      h1: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'center',
        lineHeight: '2',
        margin: '0.5em 0 0.5em 0',
      },
      h2: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      h3: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'italic',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      h4: {
        fontSize: '12pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '2',
        margin: '0.75em 0 0.5em 0',
      },
      list: { paddingLeft: '2.5em' },
    },
    IEEE: {
      body: {
        fontFamily: MS_TNR,
        fontSize: '10pt',
        lineHeight: '1.15',
        paragraphMargin: '0',
        textIndent: '0',
        textAlign: 'left',
      },
      h1: {
        fontSize: '10pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'center',
        lineHeight: '1.15',
        margin: '0.4em 0 0.3em 0',
      },
      h2: {
        fontSize: '10pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '1.15',
        margin: '0.5em 0 0.3em 0',
      },
      h3: {
        fontSize: '10pt',
        fontWeight: 'bold',
        fontStyle: 'italic',
        textAlign: 'left',
        lineHeight: '1.15',
        margin: '0.5em 0 0.3em 0',
      },
      h4: {
        fontSize: '10pt',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textAlign: 'left',
        lineHeight: '1.15',
        margin: '0.5em 0 0.3em 0',
      },
      list: { paddingLeft: '2em' },
    },
  };

  function resolveManuscriptProfileKey(styleKey) {
    var st = String(styleKey || 'APA').toUpperCase();
    if (st === 'CHICAGO' || st === 'TURABIAN') return 'CHICAGO';
    if (st === 'MLA') return 'MLA';
    if (st === 'IEEE') return 'IEEE';
    return 'APA';
  }

  var MANUSCRIPT_PREF_PREFIX = 'af.anvil.ms.';
  function manuscriptPrefStorageKey(sid) {
    return MANUSCRIPT_PREF_PREFIX + projectId + '.' + sid;
  }
  function readManuscriptPref(sectionId) {
    if (sectionId == null) return null;
    try {
      var raw = localStorage.getItem(manuscriptPrefStorageKey(sectionId));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  function writeManuscriptPref(sectionId, data) {
    if (sectionId == null) return;
    try {
      if (data == null) localStorage.removeItem(manuscriptPrefStorageKey(sectionId));
      else localStorage.setItem(manuscriptPrefStorageKey(sectionId), JSON.stringify(data));
    } catch (e) {}
  }
  function currentManuscriptProfileKeyForSave() {
    var pref = selectedId != null ? readManuscriptPref(selectedId) : null;
    if (pref && pref.profile) return resolveManuscriptProfileKey(pref.profile);
    var wrap = document.getElementById('anvil-quill-wrap');
    var ds = wrap && wrap.getAttribute('data-ms-profile');
    if (ds) return resolveManuscriptProfileKey(ds.toUpperCase());
    return resolveManuscriptProfileKey(projectCitationStyle());
  }
  function shouldSaveManuscriptHtml() {
    var wrap = document.getElementById('anvil-quill-wrap');
    if (wrap && wrap.classList.contains('anvil-quill-manuscript')) return true;
    if (selectedId != null) {
      var pref = readManuscriptPref(selectedId);
      if (pref && pref.enabled) return true;
    }
    return false;
  }
  function applyManuscriptChrome(wrap, quill, profileKeyRaw) {
    if (!quill || !quill.root) return;
    var pk = resolveManuscriptProfileKey(profileKeyRaw || projectCitationStyle());
    var profMs = MANUSCRIPT_PROFILES[pk] || MANUSCRIPT_PROFILES.APA;
    if (wrap) {
      wrap.classList.add('anvil-quill-manuscript');
      wrap.setAttribute('data-ms-profile', pk.toLowerCase());
    }
    quill.root.style.setProperty('font-family', profMs.body.fontFamily, 'important');
    quill.root.style.setProperty('line-height', profMs.body.lineHeight, 'important');
    quill.root.style.setProperty('font-size', profMs.body.fontSize, 'important');
  }
  function restoreManuscriptPrefAfterDeltaLoad() {
    if (selectedId == null || !quillEditor) return;
    var pref = readManuscriptPref(selectedId);
    if (!pref || !pref.enabled) return;
    var wrap = document.getElementById('anvil-quill-wrap');
    applyManuscriptChrome(wrap, quillEditor, pref.profile);
    applyManuscriptStylesToDom(quillEditor.root, projectCitationStyle(), readPaperPreference());
  }

  function normalizeCitationTextNodes(root) {
    if (!root) return;
    var walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var n;
    while ((n = walk.nextNode())) {
      nodes.push(n);
    }
    nodes.forEach(function (textNode) {
      var t = textNode.nodeValue;
      if (!t) return;
      var next = t.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\[\s*(\d{1,3})\s*\]/g, '[$1]');
      next = next.replace(/\(([^)]*)\)/g, function (_m, inner) {
        return '(' + inner.replace(/\s{2,}/g, ' ').trim() + ')';
      });
      if (next !== t) textNode.nodeValue = next;
    });
  }

  /** Word / paste: strip inline font + line-height so manuscript styles win (Quill + span Arial). */
  function stripWordPasteOverrides(root) {
    root.querySelectorAll('font').forEach(function (f) {
      var span = document.createElement('span');
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
    });
    root.querySelectorAll('[style]').forEach(function (el) {
      var st = el.style;
      st.removeProperty('font-family');
      st.removeProperty('line-height');
      st.removeProperty('letter-spacing');
      st.removeProperty('font');
      st.removeProperty('mso-bidi-font-size');
      st.removeProperty('mso-bidi-font-family');
      st.removeProperty('mso-fareast-font-family');
      var attr = el.getAttribute('style');
      if (attr && /mso-/i.test(attr)) {
        var cleaned = attr
          .split(';')
          .map(function (p) {
            return p.trim();
          })
          .filter(function (p) {
            return p && !/^mso-/i.test(p);
          })
          .join('; ')
          .trim();
        if (cleaned) el.setAttribute('style', cleaned);
        else el.removeAttribute('style');
      } else if (!attr || !String(attr).trim()) {
        el.removeAttribute('style');
      }
    });
    root.querySelectorAll('[class]').forEach(function (el) {
      var c = el.getAttribute('class');
      if (c && /Mso\w/i.test(c)) el.removeAttribute('class');
    });
  }

  function isPseudoBulletParagraphText(trimmed) {
    if (!trimmed) return false;
    if (/^\d+[.)]\s+/.test(trimmed)) return true;
    if (/^[\u00A7\u2022\u25E6\u2043\u2023\u25AA\u00B7\u25CF]{1,3}\s/.test(trimmed)) return true;
    if (/^[\*\-\u2013\u2014]\s+/.test(trimmed)) return true;
    return false;
  }

  function isNumberedPseudoBullet(trimmed) {
    return /^\d+[.)]\s+/.test(trimmed);
  }

  /** Turn consecutive ¶ starting with § / • / 1. into real ul/ol so list styling applies. */
  function convertPseudoBulletParagraphs(root) {
    var guard = 0;
    while (guard++ < 200) {
      var ps = Array.from(root.querySelectorAll('p')).filter(function (p) {
        return p.parentNode && root.contains(p);
      });
      var found = false;
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        var trimmed = (p.textContent || '').replace(/^\s+/, '');
        if (!isPseudoBulletParagraphText(trimmed)) continue;
        var parent = p.parentNode;
        var useOl = isNumberedPseudoBullet(trimmed);
        var group = [p];
        var j = i + 1;
        while (j < ps.length) {
          var pj = ps[j];
          if (pj.parentNode !== parent) break;
          var tj = (pj.textContent || '').replace(/^\s+/, '');
          if (!isPseudoBulletParagraphText(tj)) break;
          if (isNumberedPseudoBullet(tj) !== useOl) break;
          group.push(pj);
          j++;
        }
        var listEl = document.createElement(useOl ? 'ol' : 'ul');
        for (var k = 0; k < group.length; k++) {
          var li = document.createElement('li');
          li.innerHTML = stripBulletFromParagraphHtml(group[k].innerHTML, useOl);
          listEl.appendChild(li);
        }
        parent.insertBefore(listEl, group[0]);
        group.forEach(function (node) {
          if (node.parentNode) node.parentNode.removeChild(node);
        });
        found = true;
        break;
      }
      if (!found) break;
    }
  }

  /** Remove empty <p> / spacer paragraphs so double-spacing doesn’t look like extra blank lines. */
  function collapseBlankParagraphs(root) {
    Array.from(root.querySelectorAll('p')).forEach(function (p) {
      var html = (p.innerHTML || '')
        .replace(/<br\s*\/?>/gi, '')
        .replace(/&nbsp;/gi, ' ')
        .trim();
      var text = (p.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text && (!html || html === '')) {
        if (p.parentNode) p.parentNode.removeChild(p);
      }
    });
  }

  function stripBulletFromParagraphHtml(inner, numbered) {
    var d = document.createElement('div');
    d.innerHTML = inner || '';
    function walk(node) {
      if (node.nodeType === 3) {
        var t = node.nodeValue;
        var next = t;
        if (numbered) next = next.replace(/^\s*\d+[.)]\s+/, '');
        else {
          next = next
            .replace(/^\s+/, '')
            .replace(/^[\u00A7\u2022\u25E6\u2043\u2023\u25AA\u00B7\u25CF]{1,3}\s*/, '')
            .replace(/^[\*\-\u2013\u2014]\s+/, '');
        }
        node.nodeValue = next;
        return true;
      }
      for (var c = 0; c < node.childNodes.length; c++) {
        if (walk(node.childNodes[c])) return true;
      }
      return false;
    }
    walk(d);
    return d.innerHTML;
  }

  function setStyleImportant(el, prop, value) {
    el.style.setProperty(prop, value, 'important');
  }

  function applyManuscriptStylesToDom(root, styleKey, lightPaper) {
    stripWordPasteOverrides(root);
    convertPseudoBulletParagraphs(root);
    collapseBlankParagraphs(root);

    var pkey = resolveManuscriptProfileKey(styleKey);
    var prof = MANUSCRIPT_PROFILES[pkey] || MANUSCRIPT_PROFILES.APA;
    var fg = lightPaper ? '#1a1d21' : '#ffffff';
    var body = prof.body;
    var listPad = prof.list && prof.list.paddingLeft ? prof.list.paddingLeft : '2.5em';

    function hspec(tag) {
      return prof[tag] || prof.h2;
    }

    var paraMargin = body.paragraphMargin != null ? body.paragraphMargin : '0';
    var paraIndent = body.textIndent != null ? body.textIndent : '0';

    root.querySelectorAll('p').forEach(function (el) {
      setStyleImportant(el, 'font-family', body.fontFamily);
      setStyleImportant(el, 'font-size', body.fontSize);
      setStyleImportant(el, 'line-height', body.lineHeight);
      setStyleImportant(el, 'color', fg);
      el.style.setProperty('margin', paraMargin, 'important');
      setStyleImportant(el, 'text-indent', paraIndent);
      setStyleImportant(el, 'text-align', body.textAlign || 'left');
    });
    root.querySelectorAll('li').forEach(function (el) {
      setStyleImportant(el, 'font-family', body.fontFamily);
      setStyleImportant(el, 'font-size', body.fontSize);
      setStyleImportant(el, 'line-height', body.lineHeight);
      setStyleImportant(el, 'color', fg);
      el.style.setProperty('margin', '0', 'important');
      setStyleImportant(el, 'text-indent', '0');
    });
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(function (tag) {
      var spec = hspec(tag);
      root.querySelectorAll(tag).forEach(function (el) {
        setStyleImportant(el, 'font-family', body.fontFamily);
        setStyleImportant(el, 'font-size', spec.fontSize);
        setStyleImportant(el, 'font-weight', spec.fontWeight || 'bold');
        setStyleImportant(el, 'font-style', spec.fontStyle || 'normal');
        setStyleImportant(el, 'text-align', spec.textAlign || 'left');
        setStyleImportant(el, 'line-height', spec.lineHeight || body.lineHeight);
        setStyleImportant(el, 'color', fg);
        el.style.setProperty('margin', spec.margin || '0.75em 0 0.5em 0', 'important');
        setStyleImportant(el, 'text-indent', '0');
      });
    });
    root.querySelectorAll('ol').forEach(function (el) {
      el.style.setProperty('padding-left', listPad, 'important');
      el.style.setProperty('margin', '0.25em 0', 'important');
      setStyleImportant(el, 'list-style-type', 'decimal');
      setStyleImportant(el, 'list-style-position', 'outside');
    });
    root.querySelectorAll('ul').forEach(function (el) {
      el.style.setProperty('padding-left', listPad, 'important');
      el.style.setProperty('margin', '0.25em 0', 'important');
      setStyleImportant(el, 'list-style-type', 'disc');
      setStyleImportant(el, 'list-style-position', 'outside');
    });
    root.querySelectorAll('blockquote').forEach(function (el) {
      setStyleImportant(el, 'font-family', body.fontFamily);
      setStyleImportant(el, 'font-size', body.fontSize);
      setStyleImportant(el, 'line-height', body.lineHeight);
      setStyleImportant(el, 'color', fg);
      el.style.setProperty('margin', '0 0 0.5em 1.5em', 'important');
      setStyleImportant(el, 'padding-left', '2em');
    });
    root.querySelectorAll('blockquote p').forEach(function (el) {
      setStyleImportant(el, 'text-indent', '0');
    });
    root.querySelectorAll('img').forEach(function (el) {
      el.style.setProperty('max-width', '100%', 'important');
      el.style.setProperty('height', 'auto', 'important');
    });

    var inlineSel =
      'p span, p strong, p em, p b, p i, p u, p s, p a, li span, li strong, li em, li b, li i, li u, li s, li a';
    root.querySelectorAll(inlineSel).forEach(function (el) {
      setStyleImportant(el, 'font-family', body.fontFamily);
      setStyleImportant(el, 'font-size', body.fontSize);
      setStyleImportant(el, 'line-height', body.lineHeight);
      setStyleImportant(el, 'color', fg);
    });
  }

  /** Apply manuscript styling + citation spacing cleanup to HTML (does not change the live editor). */
  function prepareManuscriptHtml(rawHtml, lightPaper) {
    var div = document.createElement('div');
    div.innerHTML = rawHtml || '';
    applyManuscriptStylesToDom(div, projectCitationStyle(), lightPaper);
    normalizeCitationTextNodes(div);
    return div.innerHTML;
  }

  function prepareManuscriptHtmlForExport(rawHtml) {
    return prepareManuscriptHtml(rawHtml, true);
  }

  function sectionsForProjectExport() {
    if (!bundle || !bundle.sections) return [];
    return bundle.sections.map(function (s) {
      var body;
      if (selectedId != null && Number(s.id) === Number(selectedId)) {
        body = getEditorHtml();
      } else {
        body = sectionBodyToHtml(sectionBodyProp(s));
      }
      return { title: s.title, body: body };
    });
  }

  function runApplyManuscriptFormat() {
    if (!quillEditor || !quillEditor.root) {
      alert('Manuscript formatting requires the rich text editor.');
      return;
    }
    var html = getEditorHtml();
    if (htmlIsEffectivelyEmpty(html)) {
      alert('Add some text first.');
      return;
    }
    var wrap = document.getElementById('anvil-quill-wrap');
    var lightPaper = wrap && wrap.classList.contains('anvil-quill-wrap--paper');
    var style = projectCitationStyle();
    var newHtml = prepareManuscriptHtml(quillEditor.root.innerHTML, lightPaper);
    try {
      var fullLen = quillEditor.getLength();
      quillEditor.deleteText(0, fullLen, 'silent');
      quillEditor.clipboard.dangerouslyPasteHTML(0, normalizeQuillLoadHtml(newHtml), 'user');
    } catch (e) {
      alert(e.message || 'Could not apply formatting.');
      return;
    }
    var pk = resolveManuscriptProfileKey(style);
    applyManuscriptChrome(wrap, quillEditor, pk);
    if (selectedId != null) {
      writeManuscriptPref(selectedId, { enabled: true, profile: pk });
    }
    scheduleSave();
    setStatus('<span class="anvil-status-ok">Applied ' + escapeHtml(style) + ' manuscript style</span>');
  }

  function extractYear(citationText) {
    const m = String(citationText || '').match(/\b(19\d{2}|20\d{2})\b/);
    return m ? m[1] : '';
  }

  function extractAuthorLastName(citationText) {
    const s = String(citationText || '').trim();
    let m = s.match(/^\s*([A-Za-z][A-Za-z'\-]+),/);
    if (m) return m[1];
    m = s.match(/^\s*([A-Za-z][A-Za-z'\-]+)\s+(?:&|and)\s+/i);
    if (m) return m[1];
    m = s.match(/^([A-Za-z][A-Za-z'\-]+)\s+/);
    if (m) return m[1];
    return 'Source';
  }

  function buildInTextCitation(citationText, styleRaw, ieeeIndex) {
    const style = String(styleRaw || 'APA').toUpperCase();
    const author = extractAuthorLastName(citationText);
    const year = extractYear(citationText) || 'n.d.';
    if (style === 'IEEE') {
      return '[' + ieeeIndex + ']';
    }
    if (style === 'MLA') {
      return '(' + author + ')';
    }
    if (style === 'CHICAGO' || style === 'TURABIAN') {
      return '(' + author + ' ' + year + ')';
    }
    return '(' + author + ', ' + year + ')';
  }

  /**
   * Rewrites app-inserted citations (Quill anvilCitation format) to match the current project style
   * and IEEE order. Skips plain-text citations inserted before this feature existed.
   */
  function refreshAnvilCitationsInEditor() {
    if (!quillEditor || feedbackPreviewActive) return;
    if (typeof Quill === 'undefined') return;
    var Delta = Quill.import('delta');
    var d = quillEditor.getContents();
    var ops = d.ops || [];
    var newOps = [];
    var changed = false;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.retain != null || op.delete != null) {
        newOps.push(op);
        continue;
      }
      if (op.insert && typeof op.insert === 'object') {
        newOps.push(op);
        continue;
      }
      if (typeof op.insert === 'string' && op.attributes && op.attributes.anvilCitation != null) {
        var sid = parseInt(op.attributes.anvilCitation, 10);
        if (Number.isNaN(sid)) {
          newOps.push(op);
          continue;
        }
        var src = (anvilSources || []).find(function (s) {
          return Number(s.id) === sid;
        });
        if (!src || src.citation_text == null) {
          newOps.push(op);
          continue;
        }
        var ieeeIdx = ieeeIndexForSourceInSection(sid);
        var nextText = buildInTextCitation(src.citation_text, projectCitationStyle(), ieeeIdx);
        if (op.insert !== nextText) changed = true;
        newOps.push({
          insert: nextText,
          attributes: { anvilCitation: String(sid) },
        });
      } else {
        newOps.push(op);
      }
    }
    if (!changed) return;
    quillEditor.setContents(new Delta({ ops: newOps }), 'silent');
    afterExternalHtmlReplace();
    scheduleSave();
  }

  async function syncAnvilProjectOnFocus() {
    if (!document.getElementById('anvil-root')) return;
    if (feedbackPreviewActive) return;
    try {
      var data = await api('/projects/' + projectId, 'GET');
      bundle = data;
      try {
        var srcData = await api('/projects/' + projectId + '/sources', 'GET');
        anvilSources = (srcData && srcData.sources) || [];
        anvilSourcesError = null;
      } catch (e) {
        anvilSourcesError = e.message || 'Could not load sources.';
      }
      refreshAnvilCitationsInEditor();
      renderCitationsRail();
      renderFeedbackRail();
      renderResearchPlanRail();
      updateProgressBar();
    } catch (e) {
      /* ignore */
    }
  }

  function insertAtCursor(textarea, text) {
    if (!textarea || text == null) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const v = textarea.value;
    textarea.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    textarea.focus();
  }

  function insertCitation(snippet, sourceId) {
    if (quillEditor) {
      const range = quillEditor.getSelection(true);
      let index = range ? range.index : quillEditor.getLength() - 1;
      if (index < 0) index = 0;
      const sid = sourceId != null ? Number(sourceId) : NaN;
      if (!Number.isNaN(sid) && anvilCitationBlotRegistered) {
        quillEditor.insertText(index, snippet, 'user', { anvilCitation: String(sid) });
      } else {
        quillEditor.insertText(index, snippet, 'user');
      }
      quillEditor.setSelection(index + snippet.length);
      quillEditor.focus();
      scheduleSave();
      return;
    }
    const ta = document.getElementById('anvil-body');
    if (ta && ta.tagName === 'TEXTAREA') {
      insertAtCursor(ta, snippet);
      scheduleSave();
    }
  }

  async function runBuildReferences() {
    const btn = document.getElementById('anvil-build-references');
    if (btn) btn.disabled = true;
    try {
      const data = await api('/projects/' + projectId + '/references/build-from-cited', 'POST', {});
      if (data && data.bundle) bundle = data.bundle;
      if (data && data.referencesSectionId != null) {
        selectedId = Number(data.referencesSectionId);
      }
      render();
    } catch (e) {
      alert(e.message || 'Could not build references.');
    } finally {
      const b = document.getElementById('anvil-build-references');
      if (b) b.disabled = false;
    }
  }

  function categoryLabel(cat) {
    const m = {
      logic: 'Logic',
      evidence: 'Evidence',
      citations: 'Citations',
      format: 'Format',
    };
    return m[String(cat || '').toLowerCase()] || String(cat || '');
  }

  var SCORE_CATEGORIES = ['logic', 'evidence', 'citations', 'format'];
  var SCORE_RECENT_MS = 20 * 60 * 1000;

  function sectionUpdatedMs(sec) {
    if (!sec) return null;
    var raw = sec.updated_at != null ? sec.updated_at : sec.updatedAt;
    if (raw == null) return null;
    var d = new Date(raw);
    var t = d.getTime();
    return Number.isNaN(t) ? null : t;
  }

  function countSuggestionsByCategory(suggestions) {
    var out = {};
    SCORE_CATEGORIES.forEach(function (c) {
      out[c] = { open: 0, resolved: 0 };
    });
    (suggestions || []).forEach(function (s) {
      var c = String(s.category || '').toLowerCase();
      if (!out[c]) return;
      var st = String(s.status || 'open').toLowerCase();
      if (st === 'open') out[c].open++;
      else if (st === 'applied' || st === 'ignored') out[c].resolved++;
    });
    return out;
  }

  /** Bands from anvil-vision.md: Weak / Moderate / Improving / Strong (+ — when no data in category). */
  function bandForCategory(o, r, secMs) {
    var t = o + r;
    if (t === 0) return { label: '—', key: 'na' };
    if (o === 0) return { label: 'Strong', key: 'strong' };
    if (o > r) return { label: 'Weak', key: 'weak' };
    var fracOpen = o / t;
    var gap = Math.abs(o - r);
    var tieThresh = Math.max(1, Math.floor(t * 0.2));
    var roughlyEqual = gap <= tieThresh;
    if (roughlyEqual) return { label: 'Moderate', key: 'moderate' };
    var recent = secMs != null && Date.now() - secMs < SCORE_RECENT_MS;
    if (recent && fracOpen > 0.25 && o <= r) return { label: 'Improving', key: 'improving' };
    return { label: 'Moderate', key: 'moderate' };
  }

  function renderScoreStrip(suggestions) {
    var el = document.getElementById('anvil-score-strip');
    if (!el) return;
    if (!bundle || !(bundle.sections && bundle.sections.length) || selectedId == null) {
      el.innerHTML = '';
      el.setAttribute('aria-hidden', 'true');
      return;
    }
    el.removeAttribute('aria-hidden');
    var sec = sectionById(selectedId);
    var secMs = sectionUpdatedMs(sec);
    var counts = countSuggestionsByCategory(suggestions);
    var html = '';
    SCORE_CATEGORIES.forEach(function (cat) {
      var c = counts[cat];
      var band = bandForCategory(c.open, c.resolved, secMs);
      var cls = 'anvil-score-pill__val--' + (band.key === 'na' ? 'na' : band.key);
      html += '<div class="anvil-score-pill">';
      html += '<span class="anvil-score-pill__cat">' + escapeHtml(categoryLabel(cat)) + '</span>';
      html += '<span class="anvil-score-pill__val ' + cls + '">' + escapeHtml(band.label) + '</span>';
      html += '</div>';
    });
    el.innerHTML = html;
  }

  function isEvidenceSuggestion(sug) {
    return String(sug && sug.category ? sug.category : '').toLowerCase() === 'evidence';
  }

  function getEditorPlainForKeywords() {
    return htmlToPlainLinesClient(getEditorHtml()).join('\n\n').trim();
  }

  function getPassageExcerptForResearch() {
    var plain = getEditorPlainForKeywords();
    if (plain.length <= 600) return plain;
    return plain.slice(-600);
  }

  function extractKeywordsFromPlain(plain) {
    var stop = {
      that: 1,
      this: 1,
      with: 1,
      from: 1,
      have: 1,
      were: 1,
      been: 1,
      their: 1,
      would: 1,
      there: 1,
      could: 1,
      other: 1,
      which: 1,
      these: 1,
      those: 1,
      about: 1,
      into: 1,
      than: 1,
      then: 1,
      them: 1,
      some: 1,
      what: 1,
      when: 1,
      where: 1,
      while: 1,
      will: 1,
      your: 1,
    };
    var words = String(plain || '')
      .toLowerCase()
      .match(/[a-z]{4,}/g);
    if (!words) return '';
    var uniq = {};
    var out = [];
    for (var i = 0; i < words.length && out.length < 8; i++) {
      var w = words[i];
      if (stop[w]) continue;
      if (uniq[w]) continue;
      uniq[w] = 1;
      out.push(w);
    }
    return out.join(', ');
  }

  async function renderResearchPlanRail() {
    var mount = document.getElementById('anvil-research-plan-mount');
    if (!mount) return;
    if (!bundle || !projectId) {
      mount.innerHTML =
        '<p class="anvil-research-plan-empty">Research plan items appear when you add Evidence feedback here.</p>';
      return;
    }
    mount.innerHTML = '<p class="anvil-research-plan-placeholder">Loading…</p>';
    try {
      var data = await api('/projects/' + projectId + '/research-plan', 'GET');
      var items = (data && data.items) || [];
      if (!items.length) {
        mount.innerHTML =
          '<p class="anvil-research-plan-empty">Opportunities you add from <strong>Evidence</strong> feedback appear here.</p>';
        return;
      }
      var html = '<ul class="anvil-research-plan-list">';
      items.forEach(function (it) {
        var secTitle = it.sectionTitle != null ? String(it.sectionTitle) : 'Section';
        var sugId = it.suggestionId != null ? Number(it.suggestionId) : '';
        var link =
          '/app/project/' +
          projectId +
          '/anvil?section=' +
          Number(it.sectionId) +
          (sugId !== '' ? '#anvil-suggestion-' + sugId : '');
        var ex = it.passageExcerpt != null ? String(it.passageExcerpt) : '';
        html += '<li class="anvil-research-plan-card">';
        html += '<div class="anvil-research-plan-card__sec">' + escapeHtml(secTitle) + '</div>';
        if (ex) {
          var shortEx = ex.length > 240 ? ex.slice(0, 240) + '…' : ex;
          html += '<div class="anvil-research-plan-card__excerpt">' + escapeHtml(shortEx) + '</div>';
        }
        html +=
          '<div class="anvil-research-plan-card__body">' + escapeHtml(it.suggestionBody != null ? it.suggestionBody : '') + '</div>';
        if (it.keywords) {
          html +=
            '<div class="anvil-research-plan-card__kw"><span class="anvil-research-plan-card__kw-label">Keywords:</span> ' +
            escapeHtml(it.keywords) +
            '</div>';
        }
        html +=
          '<a class="anvil-research-plan-card__link" href="' +
          escapeHtml(link) +
          '">Open in Anvil</a>';
        html += '</li>';
      });
      html += '</ul>';
      mount.innerHTML = html;
    } catch (e) {
      mount.innerHTML =
        '<p class="anvil-feedback-msg anvil-feedback-msg--error" role="alert">' + escapeHtml(e.message) + '</p>';
    }
  }

  function setFeedbackApplyOverlay(show) {
    var el = document.getElementById('anvil-feedback-apply-overlay');
    if (!el) return;
    el.hidden = !show;
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  async function renderFeedbackRail() {
    const mount = document.getElementById('anvil-feedback-mount');
    if (!mount) return;

    if (!bundle || !(bundle.sections && bundle.sections.length)) {
      lastFeedbackSuggestions = [];
      mount.innerHTML =
        '<p class="anvil-feedback-msg">Feedback appears when this project has outline sections.</p>';
      renderScoreStrip([]);
      return;
    }
    if (selectedId == null) {
      lastFeedbackSuggestions = [];
      mount.innerHTML = '<p class="anvil-feedback-msg">Select a section to see suggestions.</p>';
      renderScoreStrip([]);
      return;
    }

    mount.innerHTML = '<p class="anvil-feedback-placeholder">Loading…</p>';
    try {
      const data = await api('/projects/' + projectId + '/sections/' + selectedId + '/suggestions', 'GET');
      const list = (data && data.suggestions) || [];
      lastFeedbackSuggestions = list.slice();
      renderScoreStrip(list);
      if (!list.length) {
        mount.innerHTML =
          '<p class="anvil-feedback-msg">No feedback or suggestions yet. These appear after writing stops.</p>';
        return;
      }
      let html = '<ul class="anvil-feedback-list">';
      list.forEach(function (sug) {
        const st = String(sug.status || 'open').toLowerCase();
        const isOpen = st === 'open';
        const sid = Number(sug.id);
        const evidence = isEvidenceSuggestion(sug);
        html +=
          '<li class="anvil-feedback-card" id="anvil-suggestion-' +
          sid +
          '" data-suggestion-id="' +
          sid +
          '">';
        html += '<div class="anvil-feedback-card-head">';
        html += '<span class="anvil-feedback-cat">' + escapeHtml(categoryLabel(sug.category)) + '</span>';
        if (
          feedbackPreviewActive &&
          feedbackPreviewSuggestionId != null &&
          Number(sug.id) === Number(feedbackPreviewSuggestionId)
        ) {
          html += '<span class="anvil-feedback-status anvil-feedback-status--preview">Preview</span>';
        } else if (!isOpen) {
          html +=
            '<span class="anvil-feedback-status anvil-feedback-status--' +
            escapeHtml(st) +
            '">' +
            (st === 'applied' ? 'Applied' : 'Ignored') +
            '</span>';
        }
        html += '</div>';
        html += '<div class="anvil-feedback-body">' + escapeHtml(sug.body) + '</div>';
        if (isOpen) {
          if (evidence) {
            html += '<div class="anvil-feedback-actions anvil-feedback-actions--evidence">';
            html +=
              '<button type="button" class="anvil-feedback-add-research" data-suggestion-id="' +
              sid +
              '">Add to Research Plan</button>';
            html +=
              '<button type="button" class="anvil-feedback-resolve-cite" data-suggestion-id="' +
              sid +
              '">Resolve with Citation</button>';
            html +=
              '<button type="button" class="anvil-feedback-ignore" data-suggestion-id="' +
              sid +
              '">Ignore</button>';
            html += '</div>';
          } else {
            html += '<div class="anvil-feedback-actions">';
            html +=
              '<button type="button" class="anvil-feedback-apply" data-suggestion-id="' +
              sid +
              '">Apply</button>';
            html +=
              '<button type="button" class="anvil-feedback-ignore" data-suggestion-id="' +
              sid +
              '">Ignore</button>';
            html += '</div>';
          }
        }
        html += '</li>';
      });
      html += '</ul>';
      mount.innerHTML = html;
    } catch (e) {
      lastFeedbackSuggestions = [];
      renderScoreStrip([]);
      mount.innerHTML =
        '<p class="anvil-feedback-msg anvil-feedback-msg--error" role="alert">' + escapeHtml(e.message) + '</p>';
    }
  }

  function renderCitationsRail() {
    const mount = document.getElementById('anvil-citations-mount');
    if (!mount) return;

    const rid = referencesSectionId();
    const onReferences =
      rid != null &&
      selectedId != null &&
      Number(selectedId) === Number(rid);

    const buildBar = onReferences
      ? '<div class="anvil-citations-build">' +
        '<p class="anvil-citations-build-hint">Fills this section with linked Crucible sources that appear in your draft, formatted to your project citation style.</p>' +
        '<p class="anvil-citations-build-actions">' +
        '<button type="button" class="anvil-citations-build-btn" id="anvil-build-references">Build References section</button>' +
        '</p>' +
        '</div>'
      : '';

    if (onReferences) {
      const err = anvilSourcesError
        ? '<p class="anvil-citations-msg anvil-citations-msg--error" role="alert">' +
          escapeHtml(anvilSourcesError) +
          '</p>'
        : '';
      mount.innerHTML = buildBar + err;
      return;
    }

    if (anvilSourcesError) {
      mount.innerHTML =
        '<p class="anvil-citations-msg anvil-citations-msg--error" role="alert">' +
        escapeHtml(anvilSourcesError) +
        '</p>';
      return;
    }

    if (!bundle || !(bundle.sections && bundle.sections.length)) {
      mount.innerHTML =
        '<p class="anvil-citations-msg">Sources for this section will appear here when the project has outline sections.</p>';
      return;
    }

    if (selectedId == null) {
      mount.innerHTML = '<p class="anvil-citations-msg">Select a section to see linked sources.</p>';
      return;
    }

    let linked = linkedSourcesSortedForSection(selectedId);
    if (!linked.length) {
      const cur = sectionById(selectedId);
      mount.innerHTML =
        '<p class="anvil-citations-msg">No sources linked to <strong>' +
        escapeHtml(cur ? cur.title : 'this section') +
        '</strong>. Link sources in the <a class="anvil-inline-link" href="/app/project/' +
        Number(projectId) +
        '/crucible">Crucible</a>.</p>';
      return;
    }

    const style = projectCitationStyle();
    let html =
      '<p class="anvil-citations-style-hint">In-text format: <strong>' +
      escapeHtml(style) +
      '</strong> (from project settings)</p>';
    html += '<ul class="anvil-citations-list">';
    linked.forEach(function (src, i) {
      const ieeeIdx = i + 1;
      const preview = buildInTextCitation(src.citation_text, style, ieeeIdx);
      const titleAttr = escapeHtml('Insert at cursor: ' + preview);
      html += '<li class="anvil-citation-card">';
      html += '<div class="anvil-citation-text">' + escapeHtml(src.citation_text) + '</div>';
      if (src.doi) {
        const doiHref = doiLandingPageUrl(src.doi);
        if (doiHref) {
          html +=
            '<div class="anvil-citation-doi-wrap"><a class="anvil-citation-doi" href="' +
            escapeHtml(doiHref) +
            '" target="_blank" rel="noopener noreferrer">Open DOI</a></div>';
        }
      }
      if (src.notes) {
        html += '<div class="anvil-citation-notes">' + escapeHtml(src.notes) + '</div>';
      }
      html += '<div class="anvil-citation-actions">';
      html +=
        '<button type="button" class="anvil-citation-insert" data-source-id="' +
        Number(src.id) +
        '" data-ieee-index="' +
        ieeeIdx +
        '" title="' +
        titleAttr +
        '" aria-label="' +
        titleAttr +
        '">Insert citation</button>';
      html += '<span class="anvil-citation-preview">' + escapeHtml(preview) + '</span>';
      html += '</div>';
      html += '</li>';
    });
    html += '</ul>';
    mount.innerHTML = html;
  }

  function setStatus(html) {
    const el = document.getElementById('anvil-status');
    if (el) el.innerHTML = html;
  }

  function setError(msg) {
    const el = document.getElementById('anvil-error');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = msg;
  }

  async function saveDraft(reason, opts) {
    opts = opts || {};
    if (feedbackPreviewActive) {
      if (!opts.keepalive) {
        setStatus(
          '<span class="anvil-status-wait">Preview active — use Keep or Undo below the editor</span>'
        );
      }
      return false;
    }
    if (selectedId == null || bundle == null) return false;
    let text = getEditorBodyForSave();
    if (storageIsEffectivelyEmpty(text)) text = '';
    const sec = sectionById(selectedId);
    const prev = sectionBodyProp(sec);
    if (normalizeStorageCompare(prev) === normalizeStorageCompare(text)) {
      if (!opts.keepalive) {
        setStatus('<span class="anvil-status-ok">Saved</span>');
      }
      return true;
    }

    if (!opts.keepalive) {
      setStatus('<span class="anvil-status-wait">Saving…</span>');
      setError('');
    }
    try {
      const fetchOpts = opts.keepalive ? { keepalive: true } : undefined;
      const data = await api(
        '/projects/' + projectId + '/sections/' + selectedId,
        'PATCH',
        { body: text },
        fetchOpts
      );
      if (data) bundle = data;
      if (!opts.keepalive) {
        if (opts.statusOkHtml) {
          setStatus(opts.statusOkHtml);
        } else {
          setStatus(
            '<span class="anvil-status-ok">Saved' +
              (reason ? ' · ' + escapeHtml(reason) : '') +
              '</span>'
          );
        }
        updateProgressBar();
      }
      return true;
    } catch (e) {
      if (!opts.keepalive) {
        setError(e.message);
        setStatus('<span class="anvil-status-err">Not saved</span>');
      }
      return false;
    }
  }

  /** Best-effort save when the tab hides or the page unloads (debounced save may not have run). */
  function saveDraftKeepaliveIfDirty() {
    if (feedbackPreviewActive) return;
    saveDraft('', { keepalive: true });
  }

  function hideFeedbackPreviewBar() {
    var bar = document.getElementById('anvil-feedback-preview-bar');
    var wrap = document.getElementById('anvil-quill-wrap');
    if (bar) bar.hidden = true;
    if (wrap) wrap.classList.remove('anvil-quill-wrap--feedback-preview');
  }

  function showFeedbackPreviewBar() {
    var bar = document.getElementById('anvil-feedback-preview-bar');
    var wrap = document.getElementById('anvil-quill-wrap');
    if (bar) bar.hidden = false;
    if (wrap) wrap.classList.add('anvil-quill-wrap--feedback-preview');
    setStatus('<span class="anvil-status-wait">Preview — Keep or Undo below</span>');
  }

  function endFeedbackPreviewUndo(opts) {
    opts = opts || {};
    if (!feedbackPreviewActive) return;
    var snap = feedbackPreviewSnapshotHtml;
    replaceEditorHtml(snap);
    afterExternalHtmlReplace();
    updateProgressBar();
    feedbackPreviewActive = false;
    feedbackPreviewSnapshotHtml = '';
    feedbackPreviewSuggestionId = null;
    hideFeedbackPreviewBar();
    if (!opts.quiet) {
      setStatus('<span class="anvil-status-ok">Reverted suggestion preview</span>');
    }
  }

  async function endFeedbackPreviewKeep() {
    if (!feedbackPreviewActive) return;
    var sid = feedbackPreviewSuggestionId;
    feedbackPreviewActive = false;
    feedbackPreviewSnapshotHtml = '';
    feedbackPreviewSuggestionId = null;
    hideFeedbackPreviewBar();
    try {
      var saved = await saveDraft('', {
        statusOkHtml: '<span class="anvil-status-ok">Applied and Saved</span>',
      });
      if (!saved) return;
      await api('/projects/' + projectId + '/suggestions/' + sid, 'PATCH', { status: 'applied' });
      await renderFeedbackRail();
      updateProgressBar();
    } catch (e) {
      setError(e.message || 'Could not update suggestion.');
    }
  }

  async function addToResearchPlan(sid) {
    if (selectedId == null) return;
    var sug = lastFeedbackSuggestions.find(function (s) {
      return Number(s.id) === Number(sid);
    });
    if (!sug || !isEvidenceSuggestion(sug)) return;
    try {
      await api('/projects/' + projectId + '/research-plan', 'POST', {
        suggestionId: sid,
        sectionId: selectedId,
        passageExcerpt: getPassageExcerptForResearch(),
        keywords: extractKeywordsFromPlain(getEditorPlainForKeywords()),
      });
      await renderResearchPlanRail();
      setStatus('<span class="anvil-status-ok">Added to Research Plan</span>');
    } catch (e) {
      var m = e && e.message ? String(e.message) : 'Could not add to research plan.';
      alert(m);
    }
  }

  function openEvidenceResolveDialog(sid) {
    if (selectedId == null) return;
    var sug = lastFeedbackSuggestions.find(function (s) {
      return Number(s.id) === Number(sid);
    });
    if (!sug || !isEvidenceSuggestion(sug)) return;
    var linked = linkedSourcesSortedForSection(selectedId);
    var mount = document.getElementById('anvil-evidence-resolve-sources');
    var dialog = document.getElementById('anvil-evidence-resolve-dialog');
    if (!mount || !dialog) return;
    if (!linked.length) {
      alert('No sources linked to this section. Add sources in the Crucible, then link them to this section.');
      return;
    }
    evidenceResolveSuggestionId = sid;
    var html = '';
    linked.forEach(function (src) {
      html += '<button type="button" class="anvil-evidence-resolve-pick" data-source-id="' + Number(src.id) + '">';
      html += escapeHtml(src.citation_text != null ? String(src.citation_text) : 'Source');
      html += '</button>';
    });
    mount.innerHTML = html;
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }

  async function resolveEvidenceWithCitation(suggestionId, sourceId) {
    var src = (anvilSources || []).find(function (s) {
      return Number(s.id) === Number(sourceId);
    });
    if (!src) {
      alert('Source not found. Try refreshing the page.');
      return;
    }
    var dialog = document.getElementById('anvil-evidence-resolve-dialog');
    var ieeeIdx = ieeeIndexForSourceInSection(sourceId);
    var snippet = buildInTextCitation(src.citation_text, projectCitationStyle(), ieeeIdx);
    insertCitation(snippet, sourceId);
    await api('/projects/' + projectId + '/suggestions/' + suggestionId, 'PATCH', { status: 'applied' });
    if (dialog && typeof dialog.close === 'function') dialog.close();
    evidenceResolveSuggestionId = null;
    await renderFeedbackRail();
    await renderResearchPlanRail();
    scheduleSave();
    setStatus('<span class="anvil-status-ok">Citation inserted · feedback resolved</span>');
  }

  async function applyFeedbackSuggestion(sid) {
    if (!quillEditor) {
      alert('Apply requires the rich text editor.');
      return;
    }
    if (selectedId == null) return;
    if (feedbackPreviewActive) {
      if (!window.confirm('Replace the current preview with this suggestion?')) return;
      endFeedbackPreviewUndo({ quiet: true });
    }
    var snapshot = getEditorHtml();
    setFeedbackApplyOverlay(true);
    try {
      var data = await api(
        '/projects/' +
          projectId +
          '/sections/' +
          selectedId +
          '/suggestions/' +
          sid +
          '/apply-draft',
        'POST',
        { html: snapshot }
      );
      var newHtml = data && data.html ? String(data.html) : '';
      if (!newHtml.trim()) throw new Error('Empty response');
      feedbackPreviewSnapshotHtml = snapshot;
      feedbackPreviewSuggestionId = sid;
      replaceEditorHtml(newHtml);
      afterExternalHtmlReplace();
      feedbackPreviewActive = true;
      showFeedbackPreviewBar();
      updateProgressBar();
      await renderFeedbackRail();
    } catch (e) {
      alert(e.message || 'Could not apply suggestion.');
    } finally {
      setFeedbackApplyOverlay(false);
    }
  }

  function bindFeedbackPreviewBar() {
    var keep = document.getElementById('anvil-feedback-preview-keep');
    var undo = document.getElementById('anvil-feedback-preview-undo');
    if (keep) {
      keep.onclick = function () {
        endFeedbackPreviewKeep();
      };
    }
    if (undo) {
      undo.onclick = function () {
        endFeedbackPreviewUndo();
      };
    }
  }

  function scheduleSave() {
    if (feedbackPreviewActive) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      saveDraft();
    }, DEBOUNCE_MS);
    setStatus('<span class="anvil-status-wait">Unsaved changes…</span>');
  }

  function initialSectionIdFromUrl() {
    try {
      const u = new URL(window.location.href);
      const s = u.searchParams.get('section');
      if (s == null) return null;
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? null : n;
    } catch (e) {
      return null;
    }
  }

  /** Phase 10: center-column progress (word count, section status). */
  function wordCountFromHtml(html) {
    if (htmlIsEffectivelyEmpty(html)) return 0;
    var lines = htmlToPlainLinesClient(html);
    var t = lines.join('\n').trim();
    if (!t) return 0;
    return t.split(/\s+/).filter(Boolean).length;
  }

  function wordCountFromStoredBody(raw) {
    if (raw == null || !String(raw).trim()) return 0;
    return wordCountFromHtml(sectionBodyToHtml(raw));
  }

  function totalProjectWordCount() {
    if (!bundle || !bundle.sections) return 0;
    var sum = 0;
    bundle.sections.forEach(function (s) {
      sum += wordCountFromStoredBody(sectionBodyProp(s));
    });
    return sum;
  }

  function humanizeSectionStatus(sec) {
    if (!sec) return '—';
    var st = sec.status != null ? String(sec.status) : 'not_started';
    var stLabel = st.replace(/_/g, ' ');
    stLabel = stLabel.replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
    var pp = sec.progress_percent != null ? sec.progress_percent : sec.progressPercent;
    var p = parseInt(pp, 10);
    if (!Number.isNaN(p)) {
      return stLabel + ' · ' + p + '%';
    }
    return stLabel;
  }

  function updateProgressBar() {
    var wEl = document.getElementById('anvil-progress-words');
    var sEl = document.getElementById('anvil-progress-section');
    var tgtEl = document.getElementById('anvil-progress-section-target');
    var docEl = document.getElementById('anvil-progress-doc-pct');
    if (!wEl || !sEl) return;
    var html = getEditorHtml();
    wEl.textContent = String(wordCountFromHtml(html));
    var sec = sectionById(selectedId);
    sEl.textContent = humanizeSectionStatus(sec);
    var tm = bundle && bundle.templateMeta;
    var totalWords = tm && tm.projectedTotalWords;
    var pp = sec && (sec.progress_percent != null ? sec.progress_percent : sec.progressPercent);
    var p = parseInt(pp, 10);
    if (tgtEl) {
      if (totalWords && !Number.isNaN(p) && totalWords > 0) {
        var targetSec = Math.round((totalWords * p) / 100);
        tgtEl.textContent = '~' + targetSec + ' words';
      } else {
        tgtEl.textContent = '—';
      }
    }
    if (docEl) {
      if (totalWords && totalWords > 0) {
        var sum = totalProjectWordCount();
        var pct = Math.min(100, Math.round((sum / totalWords) * 100));
        docEl.textContent = '~' + pct + '%';
      } else {
        docEl.textContent = '—';
      }
    }
  }

  function render() {
    if (!bundle) return;
    feedbackPreviewActive = false;
    feedbackPreviewSnapshotHtml = '';
    feedbackPreviewSuggestionId = null;
    if (reviewTimer) {
      clearTimeout(reviewTimer);
      reviewTimer = null;
    }

    const sections = bundle.sections || [];
    if (!sections.length) {
      root.innerHTML =
        '<div class="anvil-panel"><p class="anvil-muted">No sections in this project. Add sections via your project template or create a new project.</p></div>';
      renderCitationsRail();
      renderFeedbackRail();
      renderResearchPlanRail();
      return;
    }

    if (selectedId == null) selectedId = Number(sections[0].id);

    let current = sectionById(selectedId);
    if (!current && sections.length) {
      selectedId = Number(sections[0].id);
      current = sectionById(selectedId);
    }
    const draft = sectionBodyProp(current);

    const editor =
      '<div class="anvil-editor">' +
      '<div class="anvil-editor-label">Section: <strong>' +
      escapeHtml(current ? current.title : '') +
      '</strong></div>' +
      '<div class="anvil-progress" id="anvil-progress" aria-label="Writing progress">' +
      '<span class="anvil-progress__item"><span class="anvil-progress__k">Words</span> ' +
      '<span id="anvil-progress-words">0</span></span>' +
      '<span class="anvil-progress__sep" aria-hidden="true">·</span>' +
      '<span class="anvil-progress__item"><span class="anvil-progress__k">Section</span> ' +
      '<span id="anvil-progress-section">—</span></span>' +
      '<span class="anvil-progress__sep" aria-hidden="true">·</span>' +
      '<span class="anvil-progress__item"><span class="anvil-progress__k">Section target</span> ' +
      '<span id="anvil-progress-section-target">—</span></span>' +
      '<span class="anvil-progress__sep" aria-hidden="true">·</span>' +
      '<span class="anvil-progress__item"><span class="anvil-progress__k">Document</span> ' +
      '<span id="anvil-progress-doc-pct">—</span></span>' +
      '</div>' +
      '<div class="anvil-quill-wrap" id="anvil-quill-wrap">' +
      '<div id="anvil-editor" class="anvil-quill"></div>' +
      '</div>' +
      '<div class="anvil-feedback-preview-bar" id="anvil-feedback-preview-bar" hidden role="region" aria-label="Suggestion preview">' +
      '<span class="anvil-feedback-preview-bar__msg">Suggestion applied — review the draft, then keep or undo.</span>' +
      '<div class="anvil-feedback-preview-bar__actions">' +
      '<button type="button" class="anvil-feedback-preview-bar__btn anvil-feedback-preview-bar__btn--primary" id="anvil-feedback-preview-keep">Keep changes</button>' +
      '<button type="button" class="anvil-feedback-preview-bar__btn" id="anvil-feedback-preview-undo">Undo</button>' +
      '</div>' +
      '</div>' +
      '<div class="anvil-editor-footer">' +
      '<div class="anvil-editor-footer__left">' +
      '<span id="anvil-status" class="anvil-status"><span class="anvil-status-ok">Saved</span></span>' +
      '</div>' +
      '<div class="anvil-editor-footer__mid">' +
      '<div class="anvil-paper-toggle-wrap">' +
      '<button type="button" class="anvil-paper-toggle" id="anvil-paper-toggle" role="switch" aria-checked="false" aria-label="Writing area: dark. Switch to white paper.">' +
      '<span class="anvil-paper-toggle__track" aria-hidden="true"><span class="anvil-paper-toggle__thumb"></span></span>' +
      '</button>' +
      '<span class="anvil-paper-toggle__hint" id="anvil-paper-toggle-hint">Light mode</span>' +
      '</div>' +
      '</div>' +
      '<div class="anvil-editor-footer__right">' +
      '<button type="button" class="anvil-save-now" id="anvil-save-now">Save now</button>' +
      '</div>' +
      '</div>' +
      '<div class="anvil-export-bar">' +
      '<div class="anvil-export-bar__row">' +
      '<span class="anvil-export-label">Export</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-txt">Current Section (Text File)</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-docx">Current Section (Word)</button>' +
      '<span class="anvil-export-sep" aria-hidden="true">·</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-apply-manuscript" title="Fonts, spacing, headings, lists, and citation spacing cleanup">' +
      'Apply ' +
      escapeHtml(projectCitationStyle()) +
      ' format</button>' +
      '<span class="anvil-export-sep" aria-hidden="true">·</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-project-txt">All Sections (Text File)</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-project-docx">All Sections (Word)</button>' +
      '</div>' +
      '</div>' +
      '<div id="anvil-error" class="anvil-error-banner" style="display:none" role="alert"></div>' +
      '</div>';

    root.innerHTML =
      '<div class="anvil-panel anvil-panel--writing"><div class="anvil-layout anvil-layout--single">' +
      editor +
      '</div></div>';

    mountEditor(draft);
    bindPaperToggle();
    bindFeedbackPreviewBar();
    updateProgressBar();

    const saveBtn = document.getElementById('anvil-save-now');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        await saveDraft('saved now');
      });
    }

    (function bindExportBar() {
      var msBtn = document.getElementById('anvil-apply-manuscript');
      if (msBtn) {
        msBtn.addEventListener('click', function () {
          runApplyManuscriptFormat();
        });
      }
      var txtBtn = document.getElementById('anvil-export-section-txt');
      var docxBtn = document.getElementById('anvil-export-section-docx');
      if (txtBtn) {
        txtBtn.addEventListener('click', function () {
          var html = prepareManuscriptHtmlForExport(getEditorHtml());
          var lines = htmlToPlainLinesClient(html);
          var cur = sectionById(selectedId);
          var head = cur && cur.title ? String(cur.title) : 'Section';
          var text = head + '\n\n' + lines.join('\n\n');
          downloadBlob(
            clientSanitizeFilename(head) + '.txt',
            new Blob([text], { type: 'text/plain;charset=utf-8' })
          );
        });
      }
      if (docxBtn) {
        docxBtn.addEventListener('click', async function () {
          if (selectedId == null) return;
          docxBtn.disabled = true;
          try {
            var html = prepareManuscriptHtmlForExport(getEditorHtml());
            var cur = sectionById(selectedId);
            var title = cur && cur.title ? String(cur.title) : 'Section';
            var blob = await apiPostDocx(
              '/projects/' + projectId + '/sections/' + selectedId + '/export-docx',
              {
                html: html,
                title: title,
                citationStyle: projectCitationStyle(),
              }
            );
            downloadBlob(clientSanitizeFilename(title) + '.docx', blob);
          } catch (e) {
            alert(e.message || 'Could not export.');
          } finally {
            docxBtn.disabled = false;
          }
        });
      }
      var projTxtBtn = document.getElementById('anvil-export-project-txt');
      var projDocxBtn = document.getElementById('anvil-export-project-docx');
      if (projTxtBtn) {
        projTxtBtn.addEventListener('click', function () {
          if (!bundle || !bundle.project) return;
          var name = String(bundle.project.name || 'Project');
          var lines = [name, ''];
          sectionsForProjectExport().forEach(function (sec) {
            var html = prepareManuscriptHtmlForExport(sec.body != null ? String(sec.body) : '');
            lines.push(String(sec.title || 'Section'));
            lines.push('');
            htmlToPlainLinesClient(html).forEach(function (line) {
              lines.push(line);
            });
            lines.push('');
          });
          var text = lines.join('\n').trim() + '\n';
          downloadBlob(
            clientSanitizeFilename(name) + '-project.txt',
            new Blob([text], { type: 'text/plain;charset=utf-8' })
          );
        });
      }
      if (projDocxBtn) {
        projDocxBtn.addEventListener('click', async function () {
          if (!bundle || !bundle.project) return;
          projDocxBtn.disabled = true;
          try {
            var name = String(bundle.project.name || 'Project');
            var sections = sectionsForProjectExport().map(function (s) {
              return {
                title: s.title != null ? String(s.title) : 'Section',
                body: prepareManuscriptHtmlForExport(s.body != null ? String(s.body) : ''),
              };
            });
            var blob = await apiPostDocx('/projects/' + projectId + '/export-project-docx', {
              projectName: name,
              citationStyle: projectCitationStyle(),
              sections: sections,
            });
            downloadBlob(clientSanitizeFilename(name) + '-project.docx', blob);
          } catch (e) {
            alert(e.message || 'Could not export.');
          } finally {
            projDocxBtn.disabled = false;
          }
        });
      }
    })();

    renderCitationsRail();
    renderFeedbackRail();
    renderResearchPlanRail();
  }

  async function load() {
    root.innerHTML = '<p class="anvil-loading">Loading workspace…</p>';
    quillEditor = null;
    anvilSources = [];
    anvilSourcesError = null;
    try {
      bundle = await api('/projects/' + projectId, 'GET');
      lastReviewContentHash = '';
      lastReviewAt = 0;
      selectedId = null;
      if (bundle.sections && bundle.sections.length) {
        const fromUrl = initialSectionIdFromUrl();
        if (
          fromUrl != null &&
          bundle.sections.some(function (s) {
            return Number(s.id) === fromUrl;
          })
        ) {
          selectedId = fromUrl;
        } else {
          selectedId = Number(bundle.sections[0].id);
        }
      }
    } catch (e) {
      bundle = null;
      root.innerHTML =
        '<div class="anvil-panel"><p class="anvil-error-banner" role="alert">Could not load project. ' +
        escapeHtml(e.message) +
        '</p></div>';
      renderCitationsRail();
      renderFeedbackRail();
      renderResearchPlanRail();
      return;
    }

    try {
      const srcData = await api('/projects/' + projectId + '/sources', 'GET');
      anvilSources = (srcData && srcData.sources) || [];
      anvilSourcesError = null;
    } catch (e) {
      anvilSources = [];
      anvilSourcesError = e.message || 'Could not load sources.';
    }

    render();
    renderResearchPlanRail();
    requestAnimationFrame(function () {
      try {
        var h = window.location.hash;
        if (h && /^#anvil-suggestion-\d+$/.test(h)) {
          var el = document.querySelector(h);
          if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      } catch (e2) {
        /* ignore */
      }
    });
  }

  document.addEventListener(
    'click',
    function (e) {
      if (!document.getElementById('anvil-root')) return;
      const a = e.target.closest('aside.app-sidebar a[href]');
      if (!a) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (a.getAttribute('target') === '_blank') return;
      let target;
      let curUrl;
      try {
        target = new URL(href, window.location.origin);
        if (target.origin !== window.location.origin) return;
        curUrl = new URL(window.location.href);
        if (target.pathname === curUrl.pathname && target.search === curUrl.search) {
          e.preventDefault();
          return;
        }
      } catch (err) {
        return;
      }
      e.preventDefault();
      (async function () {
        if (feedbackPreviewActive) {
          if (
            !window.confirm(
              'You have an uncommitted suggestion preview. Leave and revert the draft to how it was before Apply?'
            )
          ) {
            return;
          }
          endFeedbackPreviewUndo();
        }
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        await saveDraft();
        window.location.href = href;
      })();
    },
    true
  );

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      syncAnvilProjectOnFocus();
      return;
    }
    if (document.visibilityState !== 'hidden') return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    saveDraftKeepaliveIfDirty();
  });

  window.addEventListener('pagehide', function () {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    saveDraftKeepaliveIfDirty();
  });

  (function bindFeedbackActions() {
    const pane = document.getElementById('anvil-feedback-pane');
    if (!pane) return;
    pane.addEventListener('click', function (e) {
      const addRp = e.target.closest('.anvil-feedback-add-research');
      const resolveCite = e.target.closest('.anvil-feedback-resolve-cite');
      const apply = e.target.closest('.anvil-feedback-apply');
      const ignore = e.target.closest('.anvil-feedback-ignore');
      if (!addRp && !resolveCite && !apply && !ignore) return;
      const btn = addRp || resolveCite || apply || ignore;
      const sid = parseInt(btn.getAttribute('data-suggestion-id'), 10);
      if (Number.isNaN(sid)) return;
      e.preventDefault();
      if (addRp || resolveCite) {
        btn.disabled = true;
        (async function () {
          try {
            if (addRp) await addToResearchPlan(sid);
            else openEvidenceResolveDialog(sid);
          } catch (err) {
            alert(err.message || 'Could not complete action.');
          } finally {
            btn.disabled = false;
          }
        })();
        return;
      }
      btn.disabled = true;
      (async function () {
        try {
          if (apply) {
            await applyFeedbackSuggestion(sid);
          } else {
            if (
              feedbackPreviewActive &&
              feedbackPreviewSuggestionId != null &&
              sid === feedbackPreviewSuggestionId
            ) {
              endFeedbackPreviewUndo({ quiet: true });
            }
            await api('/projects/' + projectId + '/suggestions/' + sid, 'PATCH', { status: 'ignored' });
            await renderFeedbackRail();
          }
        } catch (err) {
          alert(err.message || 'Could not update suggestion.');
        } finally {
          btn.disabled = false;
        }
      })();
    });
  })();

  (function bindEvidenceResolveDialog() {
    var cancel = document.getElementById('anvil-evidence-resolve-cancel');
    var sources = document.getElementById('anvil-evidence-resolve-sources');
    var dialog = document.getElementById('anvil-evidence-resolve-dialog');
    if (dialog) {
      dialog.addEventListener('close', function () {
        evidenceResolveSuggestionId = null;
      });
    }
    if (cancel && dialog) {
      cancel.addEventListener('click', function () {
        if (dialog.open) dialog.close();
      });
    }
    if (sources) {
      sources.addEventListener('click', function (e) {
        var b = e.target.closest('.anvil-evidence-resolve-pick');
        if (!b || evidenceResolveSuggestionId == null) return;
        var srcId = parseInt(b.getAttribute('data-source-id'), 10);
        if (Number.isNaN(srcId)) return;
        var sugId = evidenceResolveSuggestionId;
        b.disabled = true;
        (async function () {
          try {
            await resolveEvidenceWithCitation(sugId, srcId);
          } catch (err) {
            alert(err.message || 'Could not resolve.');
          } finally {
            b.disabled = false;
          }
        })();
      });
    }
  })();

  (function bindCitationInsert() {
    const pane = document.getElementById('anvil-citations-pane');
    if (!pane) return;
    pane.addEventListener('click', function (e) {
      if (e.target.closest('#anvil-build-references')) {
        e.preventDefault();
        runBuildReferences();
        return;
      }
      const btn = e.target.closest('.anvil-citation-insert');
      if (!btn) return;
      const sid = parseInt(btn.getAttribute('data-source-id'), 10);
      if (Number.isNaN(sid)) return;
      const src = anvilSources.find(function (s) {
        return Number(s.id) === sid;
      });
      if (!src) return;
      const ieeeIdx = parseInt(btn.getAttribute('data-ieee-index'), 10);
      const snippet = buildInTextCitation(
        src.citation_text,
        projectCitationStyle(),
        Number.isNaN(ieeeIdx) ? 1 : ieeeIdx
      );
      insertCitation(snippet, sid);
    });
  })();

  setInterval(function () {
    if (document.getElementById('anvil-progress-words')) updateProgressBar();
  }, 60000);

  window.addEventListener('beforeunload', function (e) {
    if (!feedbackPreviewActive) return;
    e.preventDefault();
    e.returnValue = '';
  });

  load();
})();
