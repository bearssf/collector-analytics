/**
 * The Anvil — rich text (Quill) with autosave; body stored as HTML in project_sections.body.
 * Export: section .txt (client), section .docx (POST), whole project .txt/.docx (GET saved snapshot).
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

  const PAPER_PREF_KEY = 'af.anvil.paper';

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
    if (bedrockReviewDisabled || selectedId == null || bundle == null) return;
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
    const h = html && String(html).trim() ? String(html) : '<p><br></p>';
    try {
      const delta = quillEditor.clipboard.convert(h);
      quillEditor.setContents(delta, 'silent');
    } catch (e) {
      quillEditor.setText('');
    }
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

  function mountEditor(initialHtml) {
    quillEditor = null;
    const wrap = document.getElementById('anvil-quill-wrap');
    const host = document.getElementById('anvil-editor');
    if (!wrap || !host) return;

    const htmlLoad = initialHtml && String(initialHtml).trim() ? initialHtml : '';

    if (typeof Quill !== 'undefined') {
      quillEditor = new Quill('#anvil-editor', {
        theme: 'snow',
        modules: {
          toolbar: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            [{ indent: '-1' }, { indent: '+1' }],
            ['link'],
            ['clean'],
          ],
        },
        placeholder: 'Write your draft here…',
      });
      installQuillPasteColorNormalization(quillEditor);
      setQuillHtml(htmlLoad);
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
      ta.value = plainTextFromBody(htmlLoad);
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

  function sourcesLinkedToSection(sectionId) {
    const sid = Number(sectionId);
    return (anvilSources || []).filter(function (src) {
      const ids = src.sectionIds || [];
      return ids.some(function (x) {
        return Number(x) === sid;
      });
    });
  }

  /** Phase 9: soft citation check before switching sections (heuristic, not a full audit). */
  var SECTION_GUARD_MIN_PLAIN_CHARS = 150;

  function plainTextForSectionGuard() {
    var html = getEditorHtml();
    var lines = htmlToPlainLinesClient(html);
    return lines.join('\n').trim();
  }

  function draftLooksLikeInTextCitation(plainText, styleRaw) {
    var t = String(plainText || '');
    var st = String(styleRaw || 'APA').toUpperCase();
    if (st === 'IEEE') {
      return /\[[1-9]\d*\]/.test(t);
    }
    return /\([^)]{0,200}\d{4}[^)]{0,80}\)/.test(t);
  }

  function evaluateSectionSwitchGuard() {
    var plain = plainTextForSectionGuard();
    if (plain.length < SECTION_GUARD_MIN_PLAIN_CHARS) {
      return { warn: false, lines: [] };
    }
    var linked = sourcesLinkedToSection(selectedId);
    var style = projectCitationStyle();
    var lines = [];
    if (linked.length === 0) {
      lines.push(
        'This section has no sources linked in the Crucible. Link sources to sections there so citations stay traceable.'
      );
      return { warn: true, lines: lines };
    }
    if (!draftLooksLikeInTextCitation(plain, style)) {
      lines.push(
        'We could not find text that looks like in-text citations for your project style (' +
          style +
          '). If you cite sources in this section, add them before moving on.'
      );
      return { warn: true, lines: lines };
    }
    return { warn: false, lines: [] };
  }

  function ensureSectionGuardModal() {
    var el = document.getElementById('anvil-section-guard');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'anvil-section-guard';
    el.className = 'anvil-section-guard';
    el.setAttribute('hidden', '');
    el.innerHTML =
      '<div class="anvil-section-guard__backdrop" tabindex="-1"></div>' +
      '<div class="anvil-section-guard__card" role="dialog" aria-modal="true" aria-labelledby="anvil-section-guard-title">' +
      '<h2 id="anvil-section-guard-title" class="anvil-section-guard__title">Before you switch sections</h2>' +
      '<ul class="anvil-section-guard__list" id="anvil-section-guard-list"></ul>' +
      '<p class="anvil-section-guard__fine">Quick heuristic only — not a full reference check.</p>' +
      '<div class="anvil-section-guard__actions">' +
      '<button type="button" class="anvil-section-guard__btn anvil-section-guard__stay" id="anvil-section-guard-stay">Stay here</button>' +
      '<button type="button" class="anvil-section-guard__btn anvil-section-guard__go" id="anvil-section-guard-go">Continue</button>' +
      '</div></div>';
    document.body.appendChild(el);
    return el;
  }

  function openSectionGuardModal(lines) {
    return new Promise(function (resolve) {
      var root = ensureSectionGuardModal();
      var list = document.getElementById('anvil-section-guard-list');
      if (list) {
        list.innerHTML = '';
        lines.forEach(function (line) {
          var li = document.createElement('li');
          li.textContent = line;
          list.appendChild(li);
        });
      }
      root.removeAttribute('hidden');
      var stay = document.getElementById('anvil-section-guard-stay');
      var go = document.getElementById('anvil-section-guard-go');
      var backdrop = root.querySelector('.anvil-section-guard__backdrop');

      function cleanup() {
        root.setAttribute('hidden', '');
        stay.removeEventListener('click', onStay);
        go.removeEventListener('click', onGo);
        document.removeEventListener('keydown', onKey);
      }
      function onStay() {
        cleanup();
        resolve(false);
      }
      function onGo() {
        cleanup();
        resolve(true);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          onStay();
        }
      }
      stay.addEventListener('click', onStay);
      go.addEventListener('click', onGo);
      if (backdrop) backdrop.addEventListener('click', onStay);
      document.addEventListener('keydown', onKey);
      if (stay) stay.focus();
    });
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
        margin: '0 0 0.5em 0',
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
        margin: '0 0 0.5em 0',
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
        margin: '0 0 0.5em 0',
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
        margin: '0 0 0.35em 0',
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
      st.removeProperty('font-size');
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

    var pkey = resolveManuscriptProfileKey(styleKey);
    var prof = MANUSCRIPT_PROFILES[pkey] || MANUSCRIPT_PROFILES.APA;
    var fg = lightPaper ? '#1a1d21' : '#ffffff';
    var body = prof.body;
    var listPad = prof.list && prof.list.paddingLeft ? prof.list.paddingLeft : '2.5em';

    function hspec(tag) {
      return prof[tag] || prof.h2;
    }

    root.querySelectorAll('p').forEach(function (el) {
      setStyleImportant(el, 'font-family', body.fontFamily);
      setStyleImportant(el, 'font-size', body.fontSize);
      setStyleImportant(el, 'line-height', body.lineHeight);
      setStyleImportant(el, 'color', fg);
      el.style.setProperty('margin', body.margin, 'important');
      setStyleImportant(el, 'text-align', body.textAlign || 'left');
    });
    root.querySelectorAll('li').forEach(function (el) {
      setStyleImportant(el, 'font-family', body.fontFamily);
      setStyleImportant(el, 'font-size', body.fontSize);
      setStyleImportant(el, 'line-height', body.lineHeight);
      setStyleImportant(el, 'color', fg);
      el.style.setProperty('margin', '0 0 0.25em 0', 'important');
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
      });
    });
    root.querySelectorAll('ol').forEach(function (el) {
      el.style.setProperty('padding-left', listPad, 'important');
      el.style.setProperty('margin', body.margin, 'important');
      setStyleImportant(el, 'list-style-type', 'decimal');
      setStyleImportant(el, 'list-style-position', 'outside');
    });
    root.querySelectorAll('ul').forEach(function (el) {
      el.style.setProperty('padding-left', listPad, 'important');
      el.style.setProperty('margin', body.margin, 'important');
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
      var body = s.body != null ? String(s.body) : '';
      if (selectedId != null && Number(s.id) === Number(selectedId)) {
        body = getEditorHtml();
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
      quillEditor.clipboard.dangerouslyPasteHTML(0, newHtml, 'user');
    } catch (e) {
      alert(e.message || 'Could not apply formatting.');
      return;
    }
    var pk = resolveManuscriptProfileKey(style);
    var profMs = MANUSCRIPT_PROFILES[pk] || MANUSCRIPT_PROFILES.APA;
    if (wrap) {
      wrap.classList.add('anvil-quill-manuscript');
      wrap.setAttribute('data-ms-profile', pk.toLowerCase());
      quillEditor.root.style.setProperty('font-family', profMs.body.fontFamily, 'important');
      quillEditor.root.style.setProperty('line-height', profMs.body.lineHeight, 'important');
      quillEditor.root.style.setProperty('font-size', profMs.body.fontSize, 'important');
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

  function insertCitation(snippet) {
    if (quillEditor) {
      const range = quillEditor.getSelection(true);
      let index = range ? range.index : quillEditor.getLength() - 1;
      if (index < 0) index = 0;
      quillEditor.insertText(index, snippet, 'user');
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

  async function renderFeedbackRail() {
    const mount = document.getElementById('anvil-feedback-mount');
    if (!mount) return;

    if (!bundle || !(bundle.sections && bundle.sections.length)) {
      mount.innerHTML =
        '<p class="anvil-feedback-msg">Feedback appears when this project has outline sections.</p>';
      renderScoreStrip([]);
      return;
    }
    if (selectedId == null) {
      mount.innerHTML = '<p class="anvil-feedback-msg">Select a section to see suggestions.</p>';
      renderScoreStrip([]);
      return;
    }

    mount.innerHTML = '<p class="anvil-feedback-placeholder">Loading…</p>';
    try {
      const data = await api('/projects/' + projectId + '/sections/' + selectedId + '/suggestions', 'GET');
      const list = (data && data.suggestions) || [];
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
        html += '<li class="anvil-feedback-card" data-suggestion-id="' + Number(sug.id) + '">';
        html += '<div class="anvil-feedback-card-head">';
        html += '<span class="anvil-feedback-cat">' + escapeHtml(categoryLabel(sug.category)) + '</span>';
        if (!isOpen) {
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
          html += '<div class="anvil-feedback-actions">';
          html +=
            '<button type="button" class="anvil-feedback-apply" data-suggestion-id="' +
            Number(sug.id) +
            '">Apply</button>';
          html +=
            '<button type="button" class="anvil-feedback-ignore" data-suggestion-id="' +
            Number(sug.id) +
            '">Ignore</button>';
          html += '</div>';
        }
        html += '</li>';
      });
      html += '</ul>';
      mount.innerHTML = html;
    } catch (e) {
      renderScoreStrip([]);
      mount.innerHTML =
        '<p class="anvil-feedback-msg anvil-feedback-msg--error" role="alert">' + escapeHtml(e.message) + '</p>';
    }
  }

  function renderCitationsRail() {
    const mount = document.getElementById('anvil-citations-mount');
    if (!mount) return;

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

    let linked = sourcesLinkedToSection(selectedId);
    linked = linked.slice().sort(function (a, b) {
      return String(a.citation_text || '').localeCompare(String(b.citation_text || ''), undefined, {
        sensitivity: 'base',
      });
    });
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

  async function saveDraft(reason) {
    if (selectedId == null || bundle == null) return;
    let text = getEditorHtml();
    if (htmlIsEffectivelyEmpty(text)) text = '';
    const sec = sectionById(selectedId);
    const prev = sec && sec.body != null ? String(sec.body) : '';
    if (normalizeForCompare(prev) === normalizeForCompare(text)) {
      setStatus('<span class="anvil-status-ok">Saved</span>');
      return;
    }

    setStatus('<span class="anvil-status-wait">Saving…</span>');
    setError('');
    try {
      bundle = await api('/projects/' + projectId + '/sections/' + selectedId, 'PATCH', { body: text });
      setStatus(
        '<span class="anvil-status-ok">Saved' +
          (reason ? ' · ' + escapeHtml(reason) : '') +
          '</span>'
      );
      updateProgressBar();
    } catch (e) {
      setError(e.message);
      setStatus('<span class="anvil-status-err">Not saved</span>');
    }
  }

  function scheduleSave() {
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
    if (!wEl || !sEl) return;
    var html = getEditorHtml();
    wEl.textContent = String(wordCountFromHtml(html));
    var sec = sectionById(selectedId);
    sEl.textContent = humanizeSectionStatus(sec);
  }

  function render() {
    if (!bundle) return;
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
      return;
    }

    if (selectedId == null) selectedId = Number(sections[0].id);

    let current = sectionById(selectedId);
    if (!current && sections.length) {
      selectedId = Number(sections[0].id);
      current = sectionById(selectedId);
    }
    const draft = current && current.body != null ? String(current.body) : '';
    const initialHtml = bodyToHtml(draft);

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
      '</div>' +
      '<div class="anvil-quill-wrap" id="anvil-quill-wrap">' +
      '<div id="anvil-editor" class="anvil-quill"></div>' +
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
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-txt">This section (.txt)</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-docx">This section (.docx)</button>' +
      '<span class="anvil-export-sep" aria-hidden="true">·</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-apply-manuscript" title="Fonts, spacing, headings, lists, and citation spacing cleanup">' +
      'Apply ' +
      escapeHtml(projectCitationStyle()) +
      ' format</button>' +
      '</div>' +
      '<div class="anvil-export-bar__row">' +
      '<span class="anvil-export-sublabel">Whole project</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-project-txt">All sections (.txt)</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-project-docx">All sections (.docx)</button>' +
      '</div>' +
      '</div>' +
      '<div id="anvil-error" class="anvil-error-banner" style="display:none" role="alert"></div>' +
      '</div>';

    root.innerHTML =
      '<div class="anvil-panel anvil-panel--writing"><div class="anvil-layout anvil-layout--single">' +
      editor +
      '</div></div>';

    mountEditor(initialHtml);
    bindPaperToggle();
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
  }

  document.addEventListener(
    'click',
    function (e) {
      const a = e.target.closest('.app-nav--anvil-sections a');
      if (!a || !document.getElementById('anvil-root')) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = a.getAttribute('href');
      if (!href) return;
      let target;
      let curUrl;
      try {
        target = new URL(href, window.location.origin);
        curUrl = new URL(window.location.href);
        if (target.pathname === curUrl.pathname && target.search === curUrl.search) {
          e.preventDefault();
          return;
        }
      } catch (err) {
        /* ignore */
      }
      e.preventDefault();
      (async function () {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        await saveDraft();
        var guard = evaluateSectionSwitchGuard();
        if (guard.warn && guard.lines.length) {
          var proceed = await openSectionGuardModal(guard.lines);
          if (!proceed) {
            setAiReviewHint('Stayed on this section — add Crucible links or in-text citations when ready.');
            return;
          }
        }
        window.location.href = href;
      })();
    },
    true
  );

  (function bindFeedbackActions() {
    const pane = document.getElementById('anvil-feedback-pane');
    if (!pane) return;
    pane.addEventListener('click', function (e) {
      const apply = e.target.closest('.anvil-feedback-apply');
      const ignore = e.target.closest('.anvil-feedback-ignore');
      if (!apply && !ignore) return;
      const btn = apply || ignore;
      const sid = parseInt(btn.getAttribute('data-suggestion-id'), 10);
      if (Number.isNaN(sid)) return;
      e.preventDefault();
      const status = apply ? 'applied' : 'ignored';
      btn.disabled = true;
      (async function () {
        try {
          await api('/projects/' + projectId + '/suggestions/' + sid, 'PATCH', { status: status });
          await renderFeedbackRail();
        } catch (err) {
          alert(err.message || 'Could not update suggestion.');
        } finally {
          btn.disabled = false;
        }
      })();
    });
  })();

  (function bindCitationInsert() {
    const pane = document.getElementById('anvil-citations-pane');
    if (!pane) return;
    pane.addEventListener('click', function (e) {
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
      insertCitation(snippet);
    });
  })();

  setInterval(function () {
    if (document.getElementById('anvil-progress-words')) updateProgressBar();
  }, 60000);

  load();
})();
