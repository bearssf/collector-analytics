/**
 * The Anvil — structured anchor-based feedback (see docs/ai-feedback-system-spec.md).
 * POST /api/.../review-structured (no persistence to anvil_suggestions).
 */
(function () {
  function anvilT(key, fb) {
    var o = window.__I18N__ && window.__I18N__.anvil;
    return (o && o[key]) || fb;
  }

  function anvilTv(key, vars, fb) {
    var s = anvilT(key, fb);
    if (vars && typeof vars === 'object') {
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) {
          s = s.split('{' + k + '}').join(String(vars[k]));
        }
      }
    }
    return s;
  }

  function commonT(key, fb) {
    var o = window.__I18N__ && window.__I18N__.common;
    return (o && o[key]) || fb;
  }

  var root = document.getElementById('anvil-root');
  if (!root) return;

  var projectId = parseInt(root.dataset.projectId, 10);
  if (Number.isNaN(projectId)) return;

  var initialIdleMs = parseInt(root.dataset.initialIdleMs || '1800', 10);
  if (Number.isNaN(initialIdleMs) || initialIdleMs < 0) initialIdleMs = 1800;
  var incrementalChars = parseInt(root.dataset.incrementalChars || '40', 10);
  if (Number.isNaN(incrementalChars) || incrementalChars < 1) incrementalChars = 40;
  var autosaveChars = parseInt(root.dataset.autosaveChars || '250', 10);
  if (Number.isNaN(autosaveChars) || autosaveChars < 1) autosaveChars = 250;
  var charsSinceLastSave = 0;
  var editorDirty = false;
  var saveStatusRevertTimer = null;
  var lastSavedLabel = null;

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
  var anvilUserProfile = null;
  var citationUsagesList = [];
  var anvilResearchPlanItems = [];

  function recordTextFingerprint() {
    var fp = getDraftPlain();
    root.dataset.fpChars = String(fp.length);
  }
  var reviewInFlight = false;
  var taLastLen = 0;

  var feedbackRows = [];
  var pendingChange = null;
  var hasPendingChange = false;

  var STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','shall','should','may','might',
    'can','could','must','and','but','or','nor','for','yet','so','in','on','at','to',
    'of','by','with','from','as','into','through','during','before','after','above',
    'below','between','out','off','over','under','again','further','then','once','that',
    'this','these','those','it','its','not','no','all','each','every','both','few',
    'more','most','other','some','such','only','own','same','than','too','very']);

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

  /** Maps Quill format values to client.anvil keys (labels follow active locale via __I18N__). */
  var QUILL_FONT_I18N = {
    'times-new-roman': { key: 'quillFontTimesNewRoman', fb: 'Times New Roman' },
    arial: { key: 'quillFontArial', fb: 'Arial' },
    georgia: { key: 'quillFontGeorgia', fb: 'Georgia' },
    'courier-new': { key: 'quillFontCourierNew', fb: 'Courier New' },
    verdana: { key: 'quillFontVerdana', fb: 'Verdana' },
    garamond: { key: 'quillFontGaramond', fb: 'Garamond' },
    calibri: { key: 'quillFontCalibri', fb: 'Calibri' },
    cambria: { key: 'quillFontCambria', fb: 'Cambria' },
    helvetica: { key: 'quillFontHelvetica', fb: 'Helvetica' },
  };
  var QUILL_SIZE_I18N = {
    '8pt': { key: 'quillSize8pt', fb: '8 pt' },
    '9pt': { key: 'quillSize9pt', fb: '9 pt' },
    '10pt': { key: 'quillSize10pt', fb: '10 pt' },
    '11pt': { key: 'quillSize11pt', fb: '11 pt' },
    '12pt': { key: 'quillSize12pt', fb: '12 pt' },
    '14pt': { key: 'quillSize14pt', fb: '14 pt' },
    '16pt': { key: 'quillSize16pt', fb: '16 pt' },
    '18pt': { key: 'quillSize18pt', fb: '18 pt' },
    '20pt': { key: 'quillSize20pt', fb: '20 pt' },
    '24pt': { key: 'quillSize24pt', fb: '24 pt' },
  };

  /* ── Image resize overlay (clipped to editor bounds) ── */
  var resizeOverlay = null;
  var resizeHandle = null;
  var resizeTarget = null;
  var isDragging = false;

  function editorVisibleRect() {
    if (!quill) return null;
    return quill.root.getBoundingClientRect();
  }

  function editorMaxImgWidth() {
    if (!quill) return 600;
    var pad = parseFloat(getComputedStyle(quill.root).paddingLeft) || 0;
    var padR = parseFloat(getComputedStyle(quill.root).paddingRight) || 0;
    return quill.root.clientWidth - pad - padR;
  }

  function constrainImageOnLoad(img) {
    var maxW = editorMaxImgWidth();
    if (img.naturalWidth > maxW || img.offsetWidth > maxW) {
      img.style.width = maxW + 'px';
      img.style.height = 'auto';
      img.setAttribute('width', maxW);
    }
  }

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
      var maxW = editorMaxImgWidth();
      var newW = Math.max(40, Math.min(maxW, startW + (cx - startX)));
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
    var imgR = resizeTarget.getBoundingClientRect();
    var edR = editorVisibleRect();
    if (!edR) { resizeOverlay.style.display = 'none'; return; }

    var left = Math.max(imgR.left, edR.left);
    var top = Math.max(imgR.top, edR.top);
    var right = Math.min(imgR.right, edR.right);
    var bottom = Math.min(imgR.bottom, edR.bottom);

    if (right <= left || bottom <= top) {
      resizeOverlay.style.display = 'none';
      return;
    }

    resizeOverlay.style.display = 'block';
    resizeOverlay.style.left = left + 'px';
    resizeOverlay.style.top = top + 'px';
    resizeOverlay.style.width = (right - left) + 'px';
    resizeOverlay.style.height = (bottom - top) + 'px';

    var handleVisible = imgR.right <= edR.right + 6 && imgR.bottom <= edR.bottom + 6;
    resizeHandle.style.display = handleVisible ? '' : 'none';
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

    quill.root.addEventListener('scroll', function () {
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

    var observer = new MutationObserver(function () {
      if (!quill) return;
      var imgs = quill.root.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        if (!img.dataset.anvilConstrained) {
          img.dataset.anvilConstrained = '1';
          if (img.complete) {
            constrainImageOnLoad(img);
          } else {
            img.addEventListener('load', function () { constrainImageOnLoad(this); });
          }
        }
      }
    });
    observer.observe(quill.root, { childList: true, subtree: true });

    var existingImgs = quill.root.querySelectorAll('img');
    for (var i = 0; i < existingImgs.length; i++) {
      existingImgs[i].dataset.anvilConstrained = '1';
      if (existingImgs[i].complete) {
        constrainImageOnLoad(existingImgs[i]);
      } else {
        existingImgs[i].addEventListener('load', function () { constrainImageOnLoad(this); });
      }
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function sectionBarLabel(sec) {
    return typeof window.localizedSectionTitle === 'function'
      ? window.localizedSectionTitle(sec)
      : sec && sec.title != null
        ? String(sec.title)
        : '';
  }

  function researchPlanSectionLine(it) {
    var sid = it && it.section_id;
    if (sid != null && bundle && bundle.sections) {
      var sec = sectionById(Number(sid));
      if (sec) return sectionBarLabel(sec);
    }
    return it && it.section_title != null && String(it.section_title) !== '' ? String(it.section_title) : '—';
  }

  function sectionSlugKey(sec) {
    if (!sec) return '';
    var raw = sec.slug != null ? sec.slug : sec.section_slug;
    return String(raw != null ? raw : '')
      .trim()
      .toLowerCase();
  }

  function isTitleSection(sec) {
    return sectionSlugKey(sec) === 'title';
  }

  function isReferenceSection(sec) {
    return sectionSlugKey(sec) === 'reference';
  }

  function skipStructuredFeedback(sec) {
    return isTitleSection(sec) || isReferenceSection(sec);
  }

  function isHtmlBodyEmpty(html) {
    if (html == null || !String(html).trim()) return true;
    var d = document.createElement('div');
    d.innerHTML = html;
    var t = (d.textContent || '').replace(/\u00a0/g, ' ').trim();
    return !t;
  }

  function displayAuthorFromProfile(u) {
    if (!u) return '[Your name — add in Account]';
    var name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    var bits = [];
    if (u.title) bits.push(String(u.title).trim());
    if (name) bits.push(name);
    var s = bits.join(' ').trim();
    return s || '[Your name — add in Account]';
  }

  function universityFromProfile(u) {
    if (!u || !String(u.university || '').trim()) return '[University — add in Account]';
    return String(u.university).trim();
  }

  function projectDisplayTitle(proj) {
    var fb = anvilT('projectTitleFallback', 'Project title');
    if (!proj) return fb;
    return String(proj.name || proj.title || fb).trim() || fb;
  }

  function buildTitlePageHtml(styleKey, user, project) {
    var sk = (styleKey || 'APA').trim().toUpperCase();
    var author = displayAuthorFromProfile(user);
    var uni = universityFromProfile(user);
    var ptitle = escapeHtml(projectDisplayTitle(project));
    var authorH = escapeHtml(author);
    var uniH = escapeHtml(uni);
    var courseH = escapeHtml('[Course — add here; not stored in Account]');
    var instrH = escapeHtml('[Instructor — add here]');
    var dateH = escapeHtml('[Due date — add here]');
    /* APA-style student title page: title block begins after four double-spaced blank lines from the top margin. */
    var lead =
      '<p><br></p><p><br></p><p><br></p><p><br></p>';

    if (sk === 'MLA') {
      return (
        lead +
        '<p>' + authorH + '</p>' +
        '<p>' + instrH + '</p>' +
        '<p>' + courseH + '</p>' +
        '<p>' + dateH + '</p>' +
        '<p><br></p>' +
        '<p class="ql-align-center"><strong>' + ptitle + '</strong></p>'
      );
    }

    if (sk === 'IEEE') {
      return (
        lead +
        '<p class="ql-align-center"><strong>' + ptitle + '</strong></p>' +
        '<p class="ql-align-center">' + authorH + '</p>' +
        '<p class="ql-align-center">' + uniH + '</p>' +
        '<p class="ql-align-center">' + courseH + '</p>'
      );
    }

    if (sk === 'CHICAGO' || sk === 'TURABIAN') {
      return (
        lead +
        '<p class="ql-align-center"><strong>' + ptitle + '</strong></p>' +
        '<p class="ql-align-center">' + authorH + '</p>' +
        '<p class="ql-align-center">' + uniH + '</p>' +
        '<p class="ql-align-center">' + courseH + '</p>' +
        '<p class="ql-align-center">' + instrH + '</p>' +
        '<p class="ql-align-center">' + dateH + '</p>'
      );
    }

    /* APA, Harvard, AMA, Vancouver, default */
    return (
      lead +
      '<p class="ql-align-center"><strong>' + ptitle + '</strong></p>' +
      '<p class="ql-align-center">' + authorH + '</p>' +
      '<p class="ql-align-center">' + uniH + '</p>' +
      '<p class="ql-align-center">' + courseH + '</p>' +
      '<p class="ql-align-center">' + instrH + '</p>' +
      '<p class="ql-align-center">' + dateH + '</p>'
    );
  }

  function titleProfileModalKey(sec) {
    return 'anvil-title-first-visit:' + projectId + ':' + (sec && sec.id != null ? sec.id : '0');
  }

  function maybeShowTitleAccountModal(sec) {
    if (!isTitleSection(sec)) return;
    var modal = document.getElementById('anvil-title-profile-modal');
    var bodyEl = document.getElementById('anvil-title-profile-modal-text');
    if (!modal || !bodyEl) return;
    try {
      if (localStorage.getItem(titleProfileModalKey(sec))) return;
      localStorage.setItem(titleProfileModalKey(sec), '1');
    } catch (e) {
      /* still show once per load if storage fails */
    }
    var missingUni =
      !anvilUserProfile || !String(anvilUserProfile.university || '').trim();
    var parts = [
      anvilT(
        'titleModalPrefill',
        'We prefilled this page using your project title and your Account name and university when available.'
      ),
      anvilT(
        'titleModalCourseHint',
        'Course, instructor, and due date are not stored in your profile—replace the bracketed placeholders in the document.'
      ),
    ];
    if (missingUni) {
      parts.push(
        anvilT(
          'titleModalUniMissing',
          'Your university is missing from Account; add it under Account for a stronger default title page.'
        )
      );
    }
    parts.push(
      anvilT('titleModalFooter', 'You can open Account anytime to update your name or university.')
    );
    bodyEl.textContent = parts.join(' ');
    modal.hidden = false;
  }

  function closeTitleProfileModal() {
    var modal = document.getElementById('anvil-title-profile-modal');
    if (modal) modal.hidden = true;
  }

  function bibliographyHeading(styleKey) {
    var sk = (styleKey || 'APA').trim().toUpperCase();
    if (sk === 'MLA') return anvilT('bibWorksCited', 'Works Cited');
    if (sk === 'CHICAGO' || sk === 'TURABIAN') return anvilT('bibBibliography', 'Bibliography');
    if (sk === 'IEEE' || sk === 'AMA' || sk === 'VANCOUVER') return anvilT('bibReferences', 'References');
    if (sk === 'HARVARD') return anvilT('bibReferenceList', 'Reference List');
    return anvilT('bibReferences', 'References');
  }

  function refYear(src) {
    var y = (src.publication_date || '').trim().slice(0, 4);
    return y || 'n.d.';
  }

  function bibParaOpen() {
    return '<p style="padding-left:2em;text-indent:-2em;margin:0 0 0.5em">';
  }

  function formatBibliographyEntry(src, styleKey, ieeeNumber, citeCount) {
    var sk = (styleKey || 'APA').trim().toUpperCase();
    var authors = (src.authors || '').trim() || 'Author, A. A.';
    var title =
      (src.article_title || src.chapter_name || src.book_title || '').trim() ||
      (src.citation_text || '').trim().split('\n')[0] ||
      'Untitled';
    var journal = (src.journal_title || '').trim();
    var vol = (src.volume_number || '').trim();
    var issue = (src.issue_number || '').trim();
    var pages = (src.page_numbers || '').trim();
    var bookTitle = (src.book_title || '').trim();
    var pub = (src.publisher || '').trim();
    var loc = (src.publisher_location || '').trim();
    var url = (src.url || src.open_access_url || '').trim();
    var doi = (src.doi || '').trim();
    var y = refYear(src);
    var countNote = '';
    if (citeCount > 1) countNote = ' <em>(Cited ' + citeCount + '×)</em>';
    else if (citeCount === 1) countNote = '';

    var fallback = escapeHtml((src.citation_text || title).trim()) + countNote;

    if (sk === 'IEEE') {
      var num = ieeeNumber != null ? ieeeNumber : 1;
      var ie = '[' + num + '] ' + escapeHtml(authors) + ', "' + escapeHtml(title) + '," ';
      if (journal) {
        ie += escapeHtml(journal);
        if (vol) ie += ', vol. ' + escapeHtml(vol);
        if (issue) ie += ', no. ' + escapeHtml(issue);
        if (pages) ie += ', pp. ' + escapeHtml(pages);
        ie += ', ' + escapeHtml(y) + '.';
      } else {
        ie += escapeHtml(y) + '.';
      }
      return bibParaOpen() + ie + countNote + '</p>';
    }

    if (sk === 'MLA') {
      var ml = bibParaOpen() + escapeHtml(authors) + '. "' + escapeHtml(title) + '."';
      if (journal) {
        ml += ' <em>' + escapeHtml(journal) + '</em>';
        if (vol) ml += ', vol. ' + escapeHtml(vol);
        if (issue) ml += ', no. ' + escapeHtml(issue);
        ml += ', ' + escapeHtml(y);
        if (pages) ml += ', pp. ' + escapeHtml(pages);
        ml += '.';
      } else if (bookTitle) {
        ml += ' <em>' + escapeHtml(bookTitle) + '</em>, ' + escapeHtml(pub || y) + '.';
      } else {
        ml += ' ' + escapeHtml(y) + '.';
      }
      if (url) ml += ' ' + escapeHtml(url) + '.';
      return ml + countNote + '</p>';
    }

    if (sk === 'CHICAGO' || sk === 'TURABIAN') {
      var ch = bibParaOpen() + escapeHtml(authors) + '. "' + escapeHtml(title) + '."';
      if (journal) {
        ch += ' <em>' + escapeHtml(journal) + '</em> ';
        if (vol) ch += escapeHtml(vol);
        if (issue) ch += ', no. ' + escapeHtml(issue);
        ch += ' (' + escapeHtml(y) + ')';
        if (pages) ch += ': ' + escapeHtml(pages);
        ch += '.';
      } else if (bookTitle) {
        ch += ' <em>' + escapeHtml(bookTitle) + '</em> (' + escapeHtml(loc || pub || y) + ').';
      } else {
        ch += ' ' + escapeHtml(y) + '.';
      }
      if (doi) ch += ' https://doi.org/' + escapeHtml(doi) + '.';
      else if (url) ch += ' ' + escapeHtml(url) + '.';
      return ch + countNote + '</p>';
    }

    /* APA, Harvard, AMA, Vancouver — APA-style reference line */
    var ap = bibParaOpen() + escapeHtml(authors) + ' (' + escapeHtml(y) + '). ' + escapeHtml(title) + '.';
    if (journal) {
      ap += ' <em>' + escapeHtml(journal) + '</em>';
      if (vol) ap += ', <em>' + escapeHtml(vol) + '</em>';
      if (issue) ap += '(' + escapeHtml(issue) + ')';
      if (pages) ap += ', ' + escapeHtml(pages);
      ap += '.';
    } else if (bookTitle) {
      ap += ' <em>' + escapeHtml(bookTitle) + '</em>.';
      if (pub) ap += ' ' + escapeHtml(pub) + '.';
    }
    if (doi) ap += ' https://doi.org/' + escapeHtml(doi);
    else if (url) ap += ' ' + escapeHtml(url);
    ap += '</p>';
    if (ap.length < 48) return fallback;
    return ap.replace('</p>', countNote + '</p>');
  }

  function usageSourceId(u) {
    if (!u) return null;
    return u.source_id != null ? u.source_id : u.sourceId;
  }

  function ieeeFirstUseOrder(usages, sourceIds) {
    var order = [];
    var seen = {};
    (usages || []).forEach(function (u) {
      var sid = usageSourceId(u);
      if (sid == null || seen[sid]) return;
      if (sourceIds.indexOf(sid) === -1) return;
      seen[sid] = true;
      order.push(sid);
    });
    sourceIds.forEach(function (sid) {
      if (!seen[sid]) order.push(sid);
    });
    return order;
  }

  function sortSourcesAlphabetical(srcList) {
    return srcList.slice().sort(function (a, b) {
      var la = parseAuthorLastNames(a.authors)[0] || (a.article_title || '').toLowerCase();
      var lb = parseAuthorLastNames(b.authors)[0] || (b.article_title || '').toLowerCase();
      la = String(la).toLowerCase();
      lb = String(lb).toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  }

  function buildReferencePageHtml(styleKey, allSources, usages, countsBySource) {
    var sk = (styleKey || 'APA').trim().toUpperCase();
    var heading = escapeHtml(bibliographyHeading(sk));
    var usedIds = Object.keys(countsBySource || {})
      .map(function (k) {
        return parseInt(k, 10);
      })
      .filter(function (id) {
        return !Number.isNaN(id) && (countsBySource[id] || 0) > 0;
      });
    if (!usedIds.length) {
      return (
        '<h2 class="ql-align-center"><strong>' + heading + '</strong></h2>' +
        '<p><em>' +
        escapeHtml(
          anvilT(
            'noCitationsHint',
            'No in-text citations have been recorded for this project yet. Insert citations from the Crucible or Anvil source cards.'
          )
        ) +
        '</em></p>'
      );
    }
    var byId = {};
    (allSources || []).forEach(function (s) {
      byId[s.id] = s;
    });
    var list = usedIds.map(function (id) {
      return byId[id];
    }).filter(Boolean);
    var ordered;
    if (sk === 'IEEE' || sk === 'AMA' || sk === 'VANCOUVER') {
      ordered = ieeeFirstUseOrder(usages, usedIds).map(function (id) {
        return byId[id];
      }).filter(Boolean);
    } else {
      ordered = sortSourcesAlphabetical(list);
    }

    var html = '<h2 class="ql-align-center"><strong>' + heading + '</strong></h2>';
    ordered.forEach(function (src, idx) {
      var n = sk === 'IEEE' || sk === 'AMA' || sk === 'VANCOUVER' ? idx + 1 : null;
      var c = countsBySource[src.id] || 0;
      html += formatBibliographyEntry(src, sk, n, c);
    });
    return html;
  }

  function getCitationsMountEl() {
    return document.getElementById('anvil-citations-mount');
  }

  function syncAnvilRightRail(current) {
    var def = document.getElementById('anvil-rail-mode-default');
    var ref = document.getElementById('anvil-rail-mode-reference');
    if (!def || !ref) return;
    var isRef = isReferenceSection(current);
    def.hidden = isRef;
    ref.hidden = !isRef;
    if (isRef) {
      loadAnvilResearchPlan();
    } else {
      renderCitationRail();
    }
  }

  function renderAnvilResearchPlan() {
    var panel = document.getElementById('anvil-reference-research-plan');
    if (!panel) return;
    var visible = anvilResearchPlanItems.filter(function (it) {
      return it.status !== 'dismissed';
    });
    if (!visible.length) {
      panel.innerHTML =
        '<div class="crucible-rp-empty">' +
        escapeHtml(anvilT('noResearchPlanItems', 'No research plan items.')) +
        '</div>';
      return;
    }
    var html = '';
    visible.forEach(function (it) {
      var statusClass = it.status === 'resolved' ? 'crucible-rp-tile--resolved' : '';
      html += '<div class="crucible-rp-tile ' + statusClass + '" data-anvil-rp-id="' + it.id + '">';
      html +=
        '<div class="crucible-rp-tile__field"><span class="crucible-rp-label">' +
        escapeHtml(anvilT('rpSection', 'Section:')) +
        '</span> ' +
        escapeHtml(researchPlanSectionLine(it)) +
        '</div>';
      html +=
        '<div class="crucible-rp-tile__field"><span class="crucible-rp-label">' +
        escapeHtml(anvilT('rpContext', 'Context:')) +
        '</span> ' +
        escapeHtml(it.suggestion_body || '—') +
        '</div>';
      html +=
        '<div class="crucible-rp-tile__field"><span class="crucible-rp-label">' +
        escapeHtml(anvilT('rpKeywords', 'Key Words:')) +
        '</span> ' +
        escapeHtml(it.keywords || '—') +
        '</div>';
      html +=
        '<div class="crucible-rp-tile__field"><span class="crucible-rp-label">' +
        escapeHtml(anvilT('rpResearchNeeded', 'Research Needed:')) +
        '</span> ' +
        escapeHtml(it.research_needed || '—') +
        '</div>';
      html +=
        '<div class="crucible-rp-tile__field"><span class="crucible-rp-label">' +
        escapeHtml(anvilT('rpStatus', 'Status:')) +
        '</span> <span class="crucible-rp-status crucible-rp-status--' +
        escapeHtml(it.status) +
        '">' +
        escapeHtml(it.status.charAt(0).toUpperCase() + it.status.slice(1)) +
        '</span></div>';
      html += '<div class="crucible-rp-tile__actions">';
      if (it.status !== 'resolved') {
        html +=
          '<button type="button" class="crucible-rp-btn crucible-rp-btn--resolve anvil-rp-resolve" data-anvil-rp-id="' +
          it.id +
          '">' +
          escapeHtml(anvilT('rpResolve', 'Resolve')) +
          '</button>';
      }
      if (it.status !== 'dismissed') {
        html +=
          '<button type="button" class="crucible-rp-btn crucible-rp-btn--dismiss anvil-rp-dismiss" data-anvil-rp-id="' +
          it.id +
          '">' +
          escapeHtml(anvilT('rpDismiss', 'Dismiss')) +
          '</button>';
      }
      html += '</div></div>';
    });
    panel.innerHTML = html;
  }

  function updateAnvilResearchPlanStatus(itemId, newStatus) {
    api('/projects/' + projectId + '/research-plan/' + itemId, 'PATCH', { status: newStatus })
      .then(function (d) {
        for (var i = 0; i < anvilResearchPlanItems.length; i++) {
          if (anvilResearchPlanItems[i].id === itemId) {
            anvilResearchPlanItems[i] = d.item;
            break;
          }
        }
        renderAnvilResearchPlan();
      })
      .catch(function (e) {
        window.alert(
          anvilTv(
            'researchPlanUpdateFailed',
            { message: e.message || 'unknown error' },
            'Could not update research plan: {message}'
          )
        );
      });
  }

  function loadAnvilResearchPlan() {
    if (!isReferenceSection(sectionById(selectedId))) return;
    api('/projects/' + projectId + '/research-plan', 'GET')
      .then(function (d) {
        anvilResearchPlanItems = d.items || [];
        renderAnvilResearchPlan();
      })
      .catch(function (e) {
        console.error('[Anvil] research plan load failed', e);
      });
  }

  function fetchJsonOrThrow(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (parseErr) {
          data = null;
        }
        if (!r.ok) {
          var msg = (data && data.error) || text || r.statusText || 'Request failed';
          throw new Error(msg);
        }
        return data || {};
      });
    });
  }

  function applyReferenceSectionBody(force) {
    var sec = sectionById(selectedId);
    if (!isReferenceSection(sec) || !quill) return;
    var sectionIdAtStart = selectedId;
    Promise.all([
      fetchJsonOrThrow('/api/projects/' + projectId + '/sources'),
      fetchJsonOrThrow('/api/projects/' + projectId + '/citation-usages'),
    ])
      .then(function (pair) {
        if (selectedId !== sectionIdAtStart || !isReferenceSection(sectionById(selectedId))) return;
        if (!quill) return;
        var d0 = pair[0];
        var d1 = pair[1];
        var allSources = d0.sources || [];
        var usages = d1.usages || [];
        var counts = {};
        usages.forEach(function (u) {
          var sid = u.source_id != null ? u.source_id : u.sourceId;
          if (sid != null) counts[sid] = (counts[sid] || 0) + 1;
        });
        if (!force && !isHtmlBodyEmpty(getDraftHtml())) return;
        var html = buildReferencePageHtml(getProjectCitationStyle(), allSources, usages, counts);
        try {
          var delta = quill.clipboard.convert(html);
          quill.setContents(delta, 'silent');
        } catch (e) {
          quill.root.innerHTML = html;
        }
        editorDirty = true;
        applyWritingStyle();
        scheduleSave();
        charsSinceFingerprint = 0;
        recordTextFingerprint();
        loadCitationUsages();
      })
      .catch(function (e) {
        console.error('[Anvil] reference rebuild failed', e);
        window.alert(
          anvilTv(
            'referencesUpdateFailed',
            { message: e.message || 'unknown error' },
            'Could not update references: {message}'
          )
        );
      });
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
      el.textContent = text || anvilT('analyzingNewText', 'Analyzing new text…');
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
      if (row.status === 'applied' || row.status === 'dismissed' || row.status === 'resolved' || row.status === 'pending') return [row];
      var m = findAnchor(documentText, row.item);
      if (m) {
        return [{ item: row.item, status: row.status || 'active', matchPosition: m }];
      }
      if (row.item.suggestion && String(row.item.suggestion).trim() && documentText.indexOf(String(row.item.suggestion)) !== -1) {
        return [{ item: row.item, status: 'applied', matchPosition: null }];
      }
      return [];
    });
  }

  function mergeRowsFromApi(items) {
    var plain = getDraftPlain();
    var existingByDbId = {};
    feedbackRows.forEach(function (r) {
      if (r.item.dbId) existingByDbId[r.item.dbId] = r;
    });
    var merged = [];
    (items || []).forEach(function (it) {
      var existing = it.dbId ? existingByDbId[it.dbId] : null;
      if (existing) {
        existing.item = it;
        merged.push(existing);
      } else {
        merged.push({ item: it, status: it.status || 'active', matchPosition: null });
      }
    });
    feedbackRows = merged;
    rebaseFeedback(plain);
    renderFeedbackRail();
    updateScoring();
  }

  function itemHasReplacement(it) {
    if (!it || it.suggestion == null) return false;
    return String(it.suggestion).trim() !== '';
  }

  function applyFeedbackRow(row) {
    if (!quill || !row || row.status !== 'active') return;
    if (!row.item.isActionable && !itemHasReplacement(row.item)) return;
    if (hasPendingChange) {
      showPendingChangeModal();
      return;
    }
    var plain = getDraftPlain();
    var m = findAnchor(plain, row.item);
    if (!m) {
      feedbackRows = feedbackRows.filter(function (r) { return r !== row; });
      renderFeedbackRail();
      return;
    }
    var sug = row.item.suggestion != null ? String(row.item.suggestion) : '';
    var len = m.end - m.start;
    var docLen = quill.getLength();
    if (m.start < 0 || m.start + len > docLen) {
      feedbackRows = feedbackRows.filter(function (r) { return r !== row; });
      renderFeedbackRail();
      return;
    }
    var originalText = plain.slice(m.start, m.end);
    quill.deleteText(m.start, len, 'silent');
    quill.insertText(m.start, sug, 'silent');
    if (sug.length > 0) {
      quill.formatText(m.start, sug.length, { background: '#64d7ec', color: '#000000' }, 'silent');
    }
    row.status = 'pending';
    row.matchPosition = null;
    pendingChange = { row: row, originalText: originalText, replacementText: sug, quillStart: m.start };
    hasPendingChange = true;
    renderFeedbackRail();
    charsSinceFingerprint = 0;
    recordTextFingerprint();
  }

  function dismissRow(itemId) {
    var targetRow = null;
    feedbackRows = feedbackRows.map(function (row) {
      if (String(row.item.id) !== String(itemId)) return row;
      if (row.status === 'applied' || row.status === 'dismissed' || row.status === 'resolved') return row;
      targetRow = row;
      return { item: row.item, status: 'dismissed', matchPosition: null };
    });
    renderFeedbackRail();
    if (targetRow && targetRow.item.dbId) {
      api('/projects/' + projectId + '/feedback/' + targetRow.item.dbId + '/status', 'PATCH', { status: 'dismissed' })
        .then(function () { updateScoring(); })
        .catch(function () {});
    } else {
      updateScoring();
    }
  }

  var saveTimer = null;
  function scheduleSave() {
    if (hasPendingChange) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveSectionDraft();
    }, 700);
  }

  function updateSaveStatus(state, msg) {
    var el = document.getElementById('anvil-save-status');
    if (!el) return;
    if (saveStatusRevertTimer) { clearTimeout(saveStatusRevertTimer); saveStatusRevertTimer = null; }
    el.textContent = msg;
    if (state === 'unsaved') el.style.color = '#a5a5a5';
    else if (state === 'saving') el.style.color = '#d59372';
    else if (state === 'saved') {
      lastSavedLabel = msg;
      el.style.color = '#3b743c';
      saveStatusRevertTimer = setTimeout(function () {
        el.style.color = '#a5a5a5';
      }, 10000);
    }
  }

  function formatSaveTime() {
    var loc = typeof window.__LOCALE__ !== 'undefined' && window.__LOCALE__ ? String(window.__LOCALE__) : 'en';
    return new Date().toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' });
  }

  async function saveSectionDraft() {
    if (hasPendingChange) return;
    var savingId = selectedId;
    if (savingId == null || !bundle) return;
    if (!quill && !document.getElementById('anvil-fallback')) return;
    updateSaveStatus('saving', anvilT('savingStatus', 'Saving\u2026'));
    try {
      var html = getDraftHtml();
      await api('/projects/' + projectId + '/sections/' + savingId, 'PATCH', { body: html });
      var sec = sectionById(savingId);
      if (sec) sec.body = html;
      charsSinceLastSave = 0;
      editorDirty = false;
      updateSaveStatus('saved', anvilTv('savedAt', { time: formatSaveTime() }, 'Saved {time}'));
      updateProgressDisplay();
      var plain = getDraftPlain();
      api('/projects/' + projectId + '/sections/' + savingId + '/feedback/rebase', 'POST', { plainText: plain })
        .catch(function () {});
    } catch (e) {
      updateSaveStatus('unsaved', anvilT('unsavedStatus', 'Unsaved'));
    }
  }

  function renderFeedbackRail() {
    var mount = document.getElementById('anvil-feedback-mount');
    if (!mount) return;
    if (!feedbackRows.length) {
      mount.innerHTML =
        '<p class="anvil2-feedback-placeholder">' +
          anvilT(
            'forgeWriteEmpty',
            'Forge Write Assist will appear here as you make progress with your writing.'
          ) +
          '</p>';
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
      if (st === 'resolved') {
        html +=
          '<span class="anvil2-feedback-status anvil2-feedback-status--resolved">' +
          anvilT('resolved', 'Resolved') +
          '</span>';
      } else if (st === 'pending') {
        html +=
          '<span class="anvil2-feedback-status anvil2-feedback-status--pending">' +
          anvilT('pending', 'Pending') +
          '</span>';
      } else {
        html += '<span class="anvil2-feedback-status">' + escapeHtml(st) + '</span>';
      }
      html += '</div>';
      if (it.rationale) {
        html += '<p class="anvil2-feedback-rationale">' + escapeHtml(it.rationale) + '</p>';
      }
      if (it.anchorText) {
        html +=
          '<p class="anvil2-feedback-anchor"><span class="anvil2-feedback-k">' +
          anvilT('anchorLabel', 'Anchor') +
          '</span> ' +
          escapeHtml(it.anchorText) +
          '</p>';
      }
      var canShowSuggestion = (st === 'active' || st === 'pending') && itemHasReplacement(it);
      if (canShowSuggestion) {
        html +=
          '<p class="anvil2-feedback-suggestion"><span class="anvil2-feedback-k">\u2192</span> ' +
          escapeHtml(String(it.suggestion)) +
          '</p>';
      }
      html += '<div class="anvil2-feedback-actions">';
      if (st === 'pending') {
        html +=
          '<button type="button" class="anvil2-confirm-btn" data-fid="' +
          escapeHtml(String(it.id)) +
          '">' +
          anvilT('confirmBtn', 'Confirm') +
          '</button>';
        html +=
          '<button type="button" class="anvil2-undo-btn" data-fid="' +
          escapeHtml(String(it.id)) +
          '">' +
          anvilT('undoBtn', 'Undo') +
          '</button>';
      } else if (st === 'active') {
        var canApply = it.isActionable || itemHasReplacement(it);
        if (canApply) {
          html +=
            '<button type="button" class="app-btn-primary anvil2-apply" data-fid="' +
            escapeHtml(String(it.id)) +
            '">' +
            anvilT('applyBtn', 'Apply') +
            '</button>';
        }
        if (cat === 'evidence') {
          html +=
            '<button type="button" class="anvil2-research-plan-btn" data-fid="' +
            escapeHtml(String(it.id)) +
            '">' +
            anvilT('researchPlanBtn', '+ Research Plan') +
            '</button>';
        }
        html +=
          '<button type="button" class="anvil2-dismiss" data-dismiss="' +
          escapeHtml(String(it.id)) +
          '">' +
          anvilT('dismissBtn', 'Dismiss') +
          '</button>';
      }
      html += '</div></li>';
    });
    html += '</ul>';
    mount.innerHTML = html;
  }

  function confirmPendingChange() {
    if (!pendingChange || !quill) return;
    var pc = pendingChange;
    var sug = pc.replacementText;
    var plain = getDraftPlain();
    var idx = plain.indexOf(sug, Math.max(0, pc.quillStart - 20));
    if (idx === -1) idx = plain.indexOf(sug);
    if (idx !== -1 && sug.length > 0) {
      quill.formatText(idx, sug.length, { background: false, color: false }, 'silent');
    }
    pc.row.status = 'applied';
    pendingChange = null;
    hasPendingChange = false;
    editorDirty = true;
    rebaseFeedback(getDraftPlain());
    renderFeedbackRail();
    scheduleSave();
    if (pc.row.item.dbId) {
      api('/projects/' + projectId + '/feedback/' + pc.row.item.dbId + '/status', 'PATCH', { status: 'applied' })
        .then(function () { updateScoring(); })
        .catch(function () {});
    } else {
      updateScoring();
    }
    updateSaveBtn();
  }

  function undoPendingChange() {
    if (!pendingChange || !quill) return;
    var pc = pendingChange;
    var sug = pc.replacementText;
    var orig = pc.originalText;
    var plain = getDraftPlain();
    var idx = plain.indexOf(sug, Math.max(0, pc.quillStart - 20));
    if (idx === -1) idx = plain.indexOf(sug);
    if (idx !== -1) {
      if (sug.length > 0) {
        quill.formatText(idx, sug.length, { background: false, color: false }, 'silent');
      }
      quill.deleteText(idx, sug.length, 'silent');
      quill.insertText(idx, orig, 'silent');
    }
    pc.row.status = 'active';
    pendingChange = null;
    hasPendingChange = false;
    rebaseFeedback(getDraftPlain());
    renderFeedbackRail();
    updateSaveBtn();
  }

  function updateSaveBtn() {
    var btn = document.getElementById('anvil-manual-save');
    if (!btn) return;
    if (hasPendingChange) {
      btn.disabled = true;
      btn.title = anvilT('confirmUndoPendingFirst', 'Confirm or undo pending change first');
    } else {
      btn.disabled = false;
      btn.title = '';
    }
  }

  function extractKeywords(text) {
    if (!text) return '';
    var words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    var seen = {};
    var result = [];
    words.forEach(function (w) {
      if (w.length < 3 || STOP_WORDS.has(w) || seen[w]) return;
      seen[w] = true;
      result.push(w);
    });
    return result.slice(0, 10).join(', ');
  }

  function sendToResearchPlan(row) {
    if (!row || !row.item) return;
    var current = sectionById(selectedId);
    var sectionTitle = current ? current.title : '';
    var keywords = extractKeywords(row.item.anchorText);
    api('/projects/' + projectId + '/research-plan', 'POST', {
      section_id: selectedId,
      section_title: sectionTitle,
      context: row.item.anchorText,
      suggestion_body: row.item.rationale || row.item.anchorText,
      keywords: keywords,
      research_needed: anvilT('categoryEvidenceCitation', 'Evidence/Citation'),
      status: 'unresolved',
    })
      .then(function () {
        row.status = 'resolved';
        renderFeedbackRail();
        if (row.item.dbId) {
          api('/projects/' + projectId + '/feedback/' + row.item.dbId + '/status', 'PATCH', { status: 'resolved' })
            .then(function () { updateScoring(); })
            .catch(function () {});
        } else {
          updateScoring();
        }
      })
      .catch(function (e) {
        console.error('Failed to create research plan item:', e);
      });
  }

  function mapScoringCategory(cat) {
    var c = (cat || '').toLowerCase();
    if (c === 'spelling' || c === 'formatting') return 'grammar';
    return c;
  }

  function computeSectionScores() {
    var cats = { logic: 0, clarity: 0, evidence: 0, grammar: 0 };
    feedbackRows.forEach(function (row) {
      if (row.status !== 'applied' && row.status !== 'dismissed' && row.status !== 'resolved') return;
      var mapped = mapScoringCategory(row.item.category);
      if (cats[mapped] !== undefined) {
        cats[mapped] += (row.item.anchorWordCount || countAnchorWords(row.item.anchorText));
      }
    });
    return cats;
  }

  function countAnchorWords(text) {
    if (!text) return 0;
    var t = String(text).replace(/\s+/g, ' ').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function ratingForRatio(flagged, total) {
    if (total === 0) return 'strong';
    var ratio = flagged / total;
    var strongT = parseFloat(root.dataset.scoreStrong || '0.05');
    var modT = parseFloat(root.dataset.scoreModerate || '0.15');
    if (ratio <= strongT) return 'strong';
    if (ratio <= modT) return 'moderate';
    return 'low';
  }

  function updateScoring() {
    var panel = document.getElementById('anvil-scoring-panel');
    if (!panel || panel.hidden) return;
    if (skipStructuredFeedback(sectionById(selectedId))) return;
    var sectionScores = computeSectionScores();
    var current = sectionById(selectedId);
    var sectionWords = current ? countWords(current.body || getDraftHtml()) : 0;
    var sectionHtml = buildScoringGroupHtml(anvilT('sectionQuality', 'Section Quality'), sectionScores, sectionWords);

    api('/projects/' + projectId + '/feedback-scores?sectionId=' + selectedId, 'GET')
      .then(function (data) {
        var projectHtml = '';
        if (data && data.project) {
          var projCats = { logic: 0, clarity: 0, evidence: 0, grammar: 0 };
          var projTotal = 0;
          ['logic', 'clarity', 'evidence', 'grammar'].forEach(function (cat) {
            if (data.project[cat]) {
              projCats[cat] = data.project[cat].flaggedWords || 0;
              projTotal = data.project[cat].totalWords || projTotal;
            }
          });
          projectHtml = buildScoringGroupHtml(anvilT('projectQuality', 'Project Quality'), projCats, projTotal);
        }
        panel.innerHTML = sectionHtml + projectHtml;
      })
      .catch(function () {
        panel.innerHTML = sectionHtml;
      });
  }

  function buildScoringGroupHtml(title, cats, totalWords) {
    var catLabel = {
      logic: anvilT('scoreLogic', 'Logic'),
      clarity: anvilT('scoreClarity', 'Clarity'),
      evidence: anvilT('scoreEvidence', 'Evidence'),
      grammar: anvilT('scoreGrammar', 'Grammar'),
    };
    var ratingLabelMap = {
      strong: anvilT('scoreStrong', 'Strong'),
      moderate: anvilT('scoreModerate', 'Moderate'),
      low: anvilT('scoreLow', 'Low'),
    };
    var html = '<div class="anvil-scoring-group"><div class="anvil-scoring-title">' + escapeHtml(title) + '</div>';
    ['logic', 'clarity', 'evidence', 'grammar'].forEach(function (cat) {
      var flagged = cats[cat] || 0;
      var rating = ratingForRatio(flagged, totalWords);
      var fillPct = rating === 'strong' ? 100 : rating === 'moderate' ? 66 : 33;
      var label = catLabel[cat] || cat;
      var ratingLabel = ratingLabelMap[rating] || rating;
      html += '<div class="anvil-score-row">' +
        '<span class="anvil-score-label">' + label + '</span>' +
        '<div class="anvil-score-bar"><div class="anvil-score-fill anvil-score-fill--' + rating + '" style="width:' + fillPct + '%"></div></div>' +
        '<span class="anvil-score-rating anvil-score-rating--' + rating + '">' + ratingLabel + '</span>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function scheduleInitialReview() {
    if (skipStructuredFeedback(sectionById(selectedId))) return;
    if (hasCompletedInitialReview) return;
    if (initialTimer) clearTimeout(initialTimer);
    initialTimer = setTimeout(function () {
      initialTimer = null;
      requestInitialReview();
    }, initialIdleMs);
  }

  function requestInitialReview() {
    if (skipStructuredFeedback(sectionById(selectedId))) return;
    if (hasCompletedInitialReview) return;
    runStructuredReview(false);
  }

  function tryIncrementalReview() {
    if (skipStructuredFeedback(sectionById(selectedId))) return false;
    if (!hasCompletedInitialReview || reviewInFlight) return false;
    var plain = getDraftPlain();
    if (plain.length < MIN_PLAIN_CHARS) return false;
    if (Date.now() - lastReviewAt < MIN_REVIEW_INTERVAL_MS) return false;
    runStructuredReview(true);
    return true;
  }

  function runStructuredReview(isIncremental) {
    if (skipStructuredFeedback(sectionById(selectedId))) return;
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
      setAnalyzeBanner(true, anvilT('analyzingNewText', 'Analyzing new text…'));
    } else if (mount) {
      mount.innerHTML =
        '<p class="anvil2-feedback-placeholder">' +
        anvilT('forgeWriteLoading', 'Loading Forge Write Assist…') +
        '</p>';
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
              '<p class="anvil2-feedback-placeholder">' +
                anvilT('addTextForFeedback', 'Add a bit more text for feedback.') +
                '</p>';
          }
          return;
        }
        mergeRowsFromApi(items);
        if (!isIncremental) {
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

  function manualRefreshFeedback() {
    if (skipStructuredFeedback(sectionById(selectedId))) return;
    if (selectedId == null || !bundle) return;
    if (!quill && !document.getElementById('anvil-fallback')) return;
    if (reviewInFlight) return;
    var plain = getDraftPlain();
    if (plain.length < MIN_PLAIN_CHARS) return;
    lastPlainSent = '';
    lastReviewAt = 0;
    runStructuredReview(false);
  }

  function onEditorUserChange(delta) {
    editorDirty = true;
    var changeSize = deltaChangeSize(delta);
    charsSinceLastSave += changeSize;
    if (!hasPendingChange && charsSinceLastSave >= autosaveChars) {
      saveSectionDraft();
    }
    if (!hasPendingChange) scheduleSave();
    if (skipStructuredFeedback(sectionById(selectedId))) return;
    if (!hasCompletedInitialReview) {
      scheduleInitialReview();
      return;
    }
    charsSinceFingerprint += changeSize;
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

  /** Quill picker labels include an SVG; setting textContent removes it and breaks Quill. */
  function setQuillPickerLabelText(labelEl, text) {
    if (!labelEl) return;
    try {
      var svg = labelEl.querySelector('svg');
      if (!svg) {
        labelEl.textContent = text;
        return;
      }
      var svgClone = svg.cloneNode(true);
      while (labelEl.firstChild) {
        labelEl.removeChild(labelEl.firstChild);
      }
      labelEl.appendChild(svgClone);
      labelEl.appendChild(document.createTextNode(text));
    } catch (e) {
      try {
        labelEl.textContent = text;
      } catch (e2) { /* ignore */ }
    }
  }

  function fontKeyForValue(v) {
    if (v == null || v === '') return null;
    var s = String(v);
    if (QUILL_FONT_I18N[s]) return QUILL_FONT_I18N[s];
    var lower = s.toLowerCase();
    if (QUILL_FONT_I18N[lower]) return QUILL_FONT_I18N[lower];
    return null;
  }

  function localizeQuillToolbarItems() {
    try {
      var tb = document.querySelector('#anvil-quill-wrap .ql-toolbar');
      if (!tb || !quill || typeof quill.getFormat !== 'function') return;

      tb.querySelectorAll('.ql-header .ql-picker-item').forEach(function (el) {
        var v = el.getAttribute('data-value');
        if (v === '1') el.textContent = anvilT('quillHeading1', 'Heading 1');
        else if (v === '2') el.textContent = anvilT('quillHeading2', 'Heading 2');
        else if (v === '3') el.textContent = anvilT('quillHeading3', 'Heading 3');
        else el.textContent = anvilT('quillNormal', 'Normal');
      });

      tb.querySelectorAll('.ql-font .ql-picker-item').forEach(function (el) {
        var v = el.getAttribute('data-value');
        if (v === '' || v == null || v === 'false') {
          el.textContent = anvilT('quillFontDefault', 'Default');
        } else {
          var fi = fontKeyForValue(v);
          el.textContent = fi ? anvilT(fi.key, fi.fb) : String(v);
        }
      });

      tb.querySelectorAll('.ql-size .ql-picker-item').forEach(function (el) {
        var v = el.getAttribute('data-value');
        var vk = v != null && v !== '' ? String(v) : '';
        if (vk === '' || v === 'false') {
          el.textContent = anvilT('quillSizeDefault', 'Default');
        } else {
          var si = QUILL_SIZE_I18N[vk];
          el.textContent = si ? anvilT(si.key, si.fb) : vk;
        }
      });

      var tt = [
        ['.ql-bold', 'quillBold', 'Bold'],
        ['.ql-italic', 'quillItalic', 'Italic'],
        ['.ql-underline', 'quillUnderline', 'Underline'],
        ['.ql-strike', 'quillStrike', 'Strikethrough'],
        ['.ql-blockquote', 'quillBlockquote', 'Blockquote'],
        ['.ql-link', 'quillLink', 'Link'],
        ['.ql-image', 'quillImage', 'Image'],
        ['.ql-clean', 'quillClean', 'Remove formatting'],
      ];
      tt.forEach(function (pair) {
        var btn = tb.querySelector(pair[0]);
        if (btn) btn.setAttribute('title', anvilT(pair[1], pair[2]));
      });

      var fontLabelEl = tb.querySelector('.ql-font .ql-picker-label');
      if (fontLabelEl) fontLabelEl.setAttribute('title', anvilT('quillFont', 'Font'));
      var sizeLabelEl = tb.querySelector('.ql-size .ql-picker-label');
      if (sizeLabelEl) sizeLabelEl.setAttribute('title', anvilT('quillSize', 'Size'));
      var headLabelEl = tb.querySelector('.ql-header .ql-picker-label');
      if (headLabelEl) headLabelEl.setAttribute('title', anvilT('quillNormal', 'Normal'));

      var fmt = quill.getFormat();
      if (headLabelEl) {
        var h = fmt.header;
        if (h === 1 || h === '1') setQuillPickerLabelText(headLabelEl, anvilT('quillHeading1', 'Heading 1'));
        else if (h === 2 || h === '2') setQuillPickerLabelText(headLabelEl, anvilT('quillHeading2', 'Heading 2'));
        else if (h === 3 || h === '3') setQuillPickerLabelText(headLabelEl, anvilT('quillHeading3', 'Heading 3'));
        else setQuillPickerLabelText(headLabelEl, anvilT('quillNormal', 'Normal'));
      }
      if (fontLabelEl) {
        var fv = fmt.font;
        var fk = fv ? fontKeyForValue(fv) : null;
        if (fk) {
          setQuillPickerLabelText(fontLabelEl, anvilT(fk.key, fk.fb));
        } else {
          setQuillPickerLabelText(fontLabelEl, anvilT('quillFontDefault', 'Default'));
        }
      }
      if (sizeLabelEl) {
        var sv = fmt.size;
        var sk = sv != null && sv !== '' ? String(sv) : '';
        var sz = sk && QUILL_SIZE_I18N[sk] ? QUILL_SIZE_I18N[sk] : null;
        if (sz) {
          setQuillPickerLabelText(sizeLabelEl, anvilT(sz.key, sz.fb));
        } else {
          setQuillPickerLabelText(sizeLabelEl, anvilT('quillSizeDefault', 'Default'));
        }
      }
    } catch (e) {
      /* Avoid breaking Anvil load/scoring if Quill DOM differs */
    }
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
          if (skipStructuredFeedback(sectionById(selectedId))) return;
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
      placeholder: anvilT(
        'forgeWritePlaceholder',
        'As you forge ahead, Forge Write Assist will appear in the canvas to the right.'
      ),
    });

    quill.clipboard.addMatcher(Node.ELEMENT_NODE, function (node, delta) {
      return normalizePastedColors(delta);
    });

    if (draftStr) {
      try {
        var delta = quill.clipboard.convert(draftStr);
        quill.setContents(delta, 'silent');
      } catch (e) {
        quill.root.innerHTML = draftStr;
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

    var anvilToolbarLocaleTimer = null;
    function runToolbarLocaleAfterQuill() {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          localizeQuillToolbarItems();
        });
      });
    }
    function scheduleLocalizeToolbar(delayMs) {
      if (anvilToolbarLocaleTimer) clearTimeout(anvilToolbarLocaleTimer);
      anvilToolbarLocaleTimer = setTimeout(function () {
        anvilToolbarLocaleTimer = null;
        runToolbarLocaleAfterQuill();
      }, typeof delayMs === 'number' ? delayMs : 0);
    }
    quill.on('editor-change', function (eventName) {
      scheduleLocalizeToolbar(eventName === 'selection-change' ? 0 : 80);
    });
    wrap.addEventListener(
      'click',
      function () {
        scheduleLocalizeToolbar(0);
      },
      true
    );
    [0, 100, 350].forEach(function (ms) {
      setTimeout(function () {
        localizeQuillToolbarItems();
      }, ms);
    });
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
      if (hint) hint.textContent = paperMode ? anvilT('lightMode', 'Light mode') : anvilT('darkMode', 'Dark mode');
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
    var ed = document.querySelector('#anvil-quill-wrap .ql-editor');
    if (ed) {
      ed.style.lineHeight = prof.lineHeight || '2';
    }
    var len = quill.getLength();
    if (len > 1) {
      quill.formatText(0, len, 'font', prof.font, 'silent');
      quill.formatText(0, len, 'size', prof.size, 'silent');
    }
    editorDirty = true;
    try { localStorage.setItem('anvil-ms-' + projectId, style); } catch (e) {}
    scheduleSave();
  }

  function restoreManuscriptMode() {
    var stored = null;
    try { stored = localStorage.getItem('anvil-ms-' + projectId); } catch (e) {}
    if (!stored) return;
    var wrap = document.getElementById('anvil-quill-wrap');
    if (!wrap) return;
    wrap.classList.add('anvil-quill-manuscript');
    if (stored === 'IEEE') {
      wrap.setAttribute('data-ms-profile', 'ieee');
    } else {
      wrap.removeAttribute('data-ms-profile');
    }
  }

  function stripColorsForExportHtml(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    d.querySelectorAll('[style]').forEach(function (el) {
      var st = el.getAttribute('style');
      if (!st) return;
      var next = st
        .replace(/\bcolor\s*:\s*[^;]+;?/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (next) el.setAttribute('style', next);
      else el.removeAttribute('style');
    });
    d.querySelectorAll('[class]').forEach(function (el) {
      var cl = el.getAttribute('class');
      if (!cl) return;
      var next = cl
        .split(/\s+/)
        .filter(function (c) {
          return c && !/^ql-color-/.test(c) && !/^ql-bg-color-/.test(c);
        })
        .join(' ');
      if (next) el.setAttribute('class', next);
      else el.removeAttribute('class');
    });
    return d.innerHTML;
  }

  function showPendingChangeModal() {
    var modal = document.getElementById('anvil-pending-change-modal');
    if (!modal) return;
    modal.hidden = false;
  }

  function bindPendingChangeModal() {
    var modal = document.getElementById('anvil-pending-change-modal');
    if (!modal || modal.dataset.anvilBound) return;
    modal.dataset.anvilBound = '1';
    var close = function () {
      modal.hidden = true;
    };
    var btn = document.getElementById('anvil-pending-change-modal-dismiss');
    var bd = document.getElementById('anvil-pending-change-modal-backdrop');
    if (btn) btn.addEventListener('click', close);
    if (bd) bd.addEventListener('click', close);
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

  function htmlToRtf(html, opts) {
    opts = opts || {};
    var container = document.createElement('div');
    container.innerHTML = html;
    var text = container.innerText || container.textContent || '';
    var rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}';
    if (opts.rtfAlignCenter) rtf += '\\qc ';
    rtf += '\\f0\\fs24 ';
    if (opts.leadPars) {
      for (var p = 0; p < opts.leadPars; p++) {
        rtf += '\\par ';
      }
    }
    var lines = text.split('\n');
    var apaIndent = opts.apaBodyIndent;
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) rtf += '\\par ';
      if (apaIndent) rtf += '\\fi720 ';
      var line = lines[i]
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}');
      rtf += line;
    }
    rtf += '}';
    return rtf;
  }

  function exportSectionRtf() {
    if (selectedId == null) return;
    var sec = sectionById(selectedId);
    var slug = sectionSlugKey(sec);
    var style = getProjectCitationStyle();
    var html = stripColorsForExportHtml(getDraftHtml());
    var rtf = htmlToRtf(html, {
      rtfAlignCenter: slug === 'title',
      leadPars: slug === 'title' ? 4 : 0,
      apaBodyIndent: slug !== 'title' && style !== 'IEEE',
    });
    var blob = new Blob([rtf], { type: 'application/rtf' });
    var name = (sec ? sectionBarLabel(sec) : 'Section') + '.rtf';
    downloadBlob(blob, name);
  }

  function exportSectionDocx() {
    if (selectedId == null) return;
    var sec = sectionById(selectedId);
    var html = stripColorsForExportHtml(getDraftHtml());
    var title = sec ? sectionBarLabel(sec) : 'Section';
    fetch('/api/projects/' + projectId + '/sections/' + selectedId + '/export-docx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: html,
        title: title,
        citationStyle: getProjectCitationStyle(),
        sectionSlug: sectionSlugKey(sec),
      }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error(anvilT('exportFailed', 'Export failed'));
        return r.blob();
      })
      .then(function (blob) {
        downloadBlob(blob, title + '.docx');
      })
      .catch(function () { /* silently fail */ });
  }

  function exportAllRtf() {
    if (!bundle || !bundle.sections) return;
    var style = getProjectCitationStyle();
    var combined = '';
    bundle.sections.forEach(function (sec) {
      var slug = sectionSlugKey(sec);
      if (slug !== 'title') {
        combined += '<h2>' + escapeHtml(sectionBarLabel(sec)) + '</h2>';
      }
      combined += (sec.body || '') + '\n';
    });
    var rtf = htmlToRtf(stripColorsForExportHtml(combined), {
      apaBodyIndent: style !== 'IEEE',
    });
    var blob = new Blob([rtf], { type: 'application/rtf' });
    var name = (bundle.project ? bundle.project.name : 'Project') + '.rtf';
    downloadBlob(blob, name);
  }

  function exportAllDocx() {
    if (!bundle || !bundle.sections) return;
    var sections = bundle.sections.map(function (s) {
      return { title: sectionBarLabel(s), body: s.body || '', slug: s.slug };
    });
    fetch('/api/projects/' + projectId + '/export-project-docx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sections: sections,
        citationStyle: getProjectCitationStyle(),
        projectName: bundle.project ? bundle.project.name : 'Project',
      }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error(anvilT('exportFailed', 'Export failed'));
        return r.blob();
      })
      .then(function (blob) {
        var name = (bundle.project ? bundle.project.name : 'Project') + '.docx';
        downloadBlob(blob, name);
      })
      .catch(function () { /* silently fail */ });
  }

  /* ── In-text citation formatting ───────────────────────────────── */

  function parseAuthorLastNames(authorsStr) {
    if (!authorsStr) return [];
    return authorsStr.split(/[;]/).map(function (a) {
      a = a.trim();
      if (!a) return '';
      var parts = a.split(',');
      if (parts.length >= 2) return parts[0].trim();
      var words = a.split(/\s+/);
      return words[words.length - 1];
    }).filter(Boolean);
  }

  function authorInText(lastNames, style) {
    if (!lastNames.length) return anvilT('unknownAuthor', 'Unknown');
    if (lastNames.length === 1) return lastNames[0];
    if (lastNames.length === 2) {
      var sep = (style === 'APA' || style === 'HARVARD') ? ' & ' : ' and ';
      return lastNames[0] + sep + lastNames[1];
    }
    return lastNames[0] + ' et al.';
  }

  var ieeeCounter = 0;
  var ieeeMap = {};

  function getIEEENumber(sourceId) {
    if (ieeeMap[sourceId] != null) return ieeeMap[sourceId];
    ieeeCounter++;
    ieeeMap[sourceId] = ieeeCounter;
    return ieeeCounter;
  }

  function formatInTextCitation(src, style) {
    var key = (style || 'APA').trim().toUpperCase();
    var lastNames = parseAuthorLastNames(src.authors);
    var author = authorInText(lastNames, key);
    var year = (src.publication_date || '').trim().slice(0, 4) || 'n.d.';

    switch (key) {
      case 'APA':
        return '(' + author + ', ' + year + ')';
      case 'MLA':
        return '(' + author + ')';
      case 'CHICAGO':
      case 'TURABIAN':
        return '(' + author + ' ' + year + ')';
      case 'HARVARD':
        return '(' + author + ' ' + year + ')';
      case 'IEEE':
        return '[' + getIEEENumber(src.id) + ']';
      case 'AMA':
        return '<sup>' + getIEEENumber(src.id) + '</sup>';
      case 'VANCOUVER':
        return '(' + getIEEENumber(src.id) + ')';
      default:
        return '(' + author + ', ' + year + ')';
    }
  }

  /* ── Citation rail rendering ─────────────────────────────────── */

  var sectionSources = [];
  var citationUsageCounts = {};

  function loadCitationUsages() {
    fetch('/api/projects/' + projectId + '/citation-usages', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        citationUsagesList = d.usages || [];
        citationUsageCounts = {};
        citationUsagesList.forEach(function (u) {
          var sid = u.source_id != null ? u.source_id : u.sourceId;
          if (sid != null) citationUsageCounts[sid] = (citationUsageCounts[sid] || 0) + 1;
        });
        if (!isReferenceSection(sectionById(selectedId))) renderCitationRail();
      })
      .catch(function () {});
  }

  function loadSectionSources() {
    if (selectedId == null) return;
    if (isReferenceSection(sectionById(selectedId))) {
      sectionSources = [];
      return;
    }
    fetch('/api/projects/' + projectId + '/sources', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var all = d.sources || [];
        sectionSources = all.filter(function (src) {
          return (src.section_ids || []).indexOf(selectedId) !== -1;
        }).sort(function (a, b) {
          var ta = (a.article_title || '').toLowerCase();
          var tb = (b.article_title || '').toLowerCase();
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        });
        renderCitationRail();
      })
      .catch(function () {});
  }

  function renderCitationRail() {
    if (isReferenceSection(sectionById(selectedId))) return;
    var mount = getCitationsMountEl();
    if (!mount) return;
    if (!sectionSources.length) {
      mount.innerHTML =
        '<p class="app-anvil-rail__citations-placeholder">' +
        escapeHtml(anvilT('noSourcesTaggedSection', 'No sources tagged to this section.')) +
        '</p>';
      return;
    }
    var html = '';
    sectionSources.forEach(function (src) {
      var tags = (src.tags || []).map(function (t) {
        return '<span class="anvil-cite-tag">' + escapeHtml(t) + '</span>';
      }).join('');
      html += '<div class="anvil-citation-card" data-source-id="' + src.id + '">' +
        '<div class="anvil-citation-card__title">' +
        escapeHtml(src.article_title || src.citation_text || anvilT('untitledSource', '(Untitled)')) +
        '</div>' +
        '<div class="anvil-citation-card__authors">' + escapeHtml(src.authors || '') + '</div>' +
        '<div class="anvil-citation-card__date">' + escapeHtml(src.publication_date || '') + '</div>' +
        (tags ? '<div class="anvil-citation-card__tags">' + tags + '</div>' : '') +
        '<div class="anvil-citation-card__footer">' +
          '<button type="button" class="anvil-citation-insert-btn" data-source-id="' +
          src.id +
          '">' +
          escapeHtml(anvilT('insertCitation', 'Insert')) +
          '</button>' +
        '</div>' +
      '</div>';
    });
    mount.innerHTML = html;

    mount.querySelectorAll('.anvil-citation-insert-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = parseInt(btn.getAttribute('data-source-id'), 10);
        var src = sectionSources.find(function (s) { return s.id === sid; });
        if (src) insertCitation(src);
      });
    });
  }

  function insertCitation(src) {
    if (!quill || selectedId == null) return;
    if (isReferenceSection(sectionById(selectedId))) return;
    var marker = formatInTextCitation(src, getProjectCitationStyle());
    var range = quill.getSelection(true);
    var index = range ? range.index : quill.getLength() - 1;
    var insertAt = index;
    if (index > 0) {
      var before = quill.getText(index - 1, 1);
      if (before && before !== ' ') {
        quill.insertText(index, ' ', 'user');
        insertAt = index + 1;
      }
    }

    var isHtml = marker.indexOf('<sup>') !== -1;
    if (isHtml) {
      var num = marker.replace(/<\/?sup>/g, '');
      quill.insertText(insertAt, num, { script: 'super' }, 'user');
    } else {
      quill.insertText(insertAt, marker, 'user');
    }

    var body = getDraftHtml();
    var plain = getDraftPlain();
    var start = Math.max(0, insertAt - 30);
    var citeLen = isHtml ? String(marker.replace(/<\/?sup>/g, '')).length : marker.length;
    var end = Math.min(plain.length, insertAt + citeLen + 30);
    var context = plain.slice(start, end);

    fetch('/api/projects/' + projectId + '/citation-usages', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: src.id,
        section_id: selectedId,
        cite_marker: marker.replace(/<\/?sup>/g, ''),
        context_excerpt: context,
      }),
    })
    .then(function () {
      citationUsageCounts[src.id] = (citationUsageCounts[src.id] || 0) + 1;
      renderCitationRail();
    })
    .catch(function () {});
  }

  function countWords(html) {
    if (!html) return 0;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var text = (tmp.textContent || tmp.innerText || '').trim();
    if (!text) return 0;
    return text.split(/\s+/).length;
  }

  function buildProgressHtml(currentSection) {
    if (!bundle || !bundle.templateMeta || !bundle.templateMeta.projectedTotalWords) return '';
    var totalTarget = bundle.templateMeta.projectedTotalWords;
    var sections = bundle.sections || [];

    var projectWords = 0;
    sections.forEach(function (s) { projectWords += countWords(s.body); });
    var projectPct = Math.min(100, Math.round((projectWords / totalTarget) * 100));

    var sectionPct = 0;
    var sectionWords = 0;
    var sectionTarget = 0;
    if (currentSection) {
      var pctShare = currentSection.progress_percent || 0;
      sectionTarget = Math.round(totalTarget * pctShare / 100);
      sectionWords = countWords(currentSection.body);
      sectionPct = sectionTarget > 0 ? Math.min(100, Math.round((sectionWords / sectionTarget) * 100)) : 0;
    }

    return (
      '<div id="tw-anvil-progress-charts" class="anvil-progress-row">' +
      '<div class="anvil-progress-item">' +
      '<span class="anvil-progress-label">' +
      anvilTv('sectionProgress', { pct: sectionPct }, 'Section: {pct}% complete') +
      '</span>' +
      '<div class="anvil-progress-track"><div class="anvil-progress-fill" style="width:' +
      sectionPct +
      '%"></div></div>' +
      '</div>' +
      '<div class="anvil-progress-item">' +
      '<span class="anvil-progress-label">' +
      anvilTv('projectProgress', { pct: projectPct }, 'Project: {pct}% complete') +
      '</span>' +
      '<div class="anvil-progress-track"><div class="anvil-progress-fill" style="width:' +
      projectPct +
      '%"></div></div>' +
      '</div>' +
      '</div>'
    );
  }

  function updateProgressDisplay() {
    var row = document.querySelector('.anvil-progress-row');
    if (!row || !bundle) return;
    var current = sectionById(selectedId);
    var newHtml = buildProgressHtml(current);
    if (newHtml) {
      var tmp = document.createElement('div');
      tmp.innerHTML = newHtml;
      row.parentNode.replaceChild(tmp.firstChild, row);
    }
  }

  function loadFeedbackFromDb() {
    if (skipStructuredFeedback(sectionById(selectedId))) return;
    if (selectedId == null) return;
    api('/projects/' + projectId + '/sections/' + selectedId + '/feedback', 'GET')
      .then(function (data) {
        var items = (data && data.items) || [];
        if (items.length) {
          mergeRowsFromApi(items);
        }
        var plain = getDraftPlain();
        if (plain.length >= MIN_PLAIN_CHARS) {
          api('/projects/' + projectId + '/sections/' + selectedId + '/feedback/rebase', 'POST', { plainText: plain })
            .then(function (d) {
              if (d && d.items) {
                mergeRowsFromApi(d.items);
              }
            })
            .catch(function () {});
        }
      })
      .catch(function () {});
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
        '<div class="anvil-panel--writing"><p class="anvil-muted">' +
        anvilT('noSectionsProject', 'No sections in this project.') +
        '</p></div>';
      return;
    }
    if (selectedId == null) selectedId = Number(sections[0].id);
    var current = sectionById(selectedId);
    if (!current && sections.length) {
      selectedId = Number(sections[0].id);
      current = sectionById(selectedId);
    }
    var draft = sectionBodyProp(current);
    if (isTitleSection(current) && isHtmlBodyEmpty(draft)) {
      draft = buildTitlePageHtml(getProjectCitationStyle(), anvilUserProfile, bundle.project);
    }

    var citStyle = getProjectCitationStyle();
    var hideScoring = skipStructuredFeedback(current);

    var progressHtml = buildProgressHtml(current);

    root.innerHTML =
      '<div class="anvil-panel--writing">' +
      '<div class="anvil-layout--single">' +
      '<div class="anvil-top-metrics">' +
      '<div class="anvil-top-metrics__progress">' + progressHtml + '</div>' +
      '</div>' +
      '<div id="anvil-analyze-banner" class="anvil-analyze-banner" hidden aria-live="polite"></div>' +
      '<div class="anvil-editor">' +
      '<div id="anvil-quill-wrap" class="anvil-quill-wrap"><div id="anvil-editor" class="anvil-quill"></div></div>' +
      '<div class="anvil-editor-footer">' +
      '<div class="anvil-editor-footer__left">' +
        '<span id="anvil-save-status" class="anvil-save-status" style="color:#a5a5a5">' +
        (draft ? lastSavedLabel || anvilT('savedShort', 'Saved') : anvilT('unsavedStatus', 'Unsaved')) +
        '</span>' +
      '</div>' +
      '<div class="anvil-editor-footer__mid">' +
      '<div class="anvil-paper-toggle-wrap">' +
      '<button type="button" id="anvil-paper-toggle" class="anvil-paper-toggle" role="switch" aria-checked="' +
      (paperMode ? 'true' : 'false') +
      '" title="' +
      escapeHtml(anvilT('togglePaperMode', 'Toggle light/dark writing mode')) +
      '">' +
      '<span class="anvil-paper-toggle__track"><span class="anvil-paper-toggle__thumb"></span></span>' +
      '</button>' +
      '<span id="anvil-paper-hint" class="anvil-paper-toggle__hint">' +
      (paperMode ? anvilT('lightMode', 'Light mode') : anvilT('darkMode', 'Dark mode')) +
      '</span>' +
      '</div>' +
      '</div>' +
      '<div class="anvil-editor-footer__right">' +
        '<button type="button" class="anvil-save-btn" id="anvil-manual-save">' +
        escapeHtml(commonT('save', 'Save')) +
        '</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="anvil-export-bar">' +
      '<div class="anvil-export-bar__row">' +
      '<span class="anvil-export-label">' +
      escapeHtml(anvilT('actionsLabel', 'Actions')) +
      '</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-apply-style">' +
      escapeHtml(anvilTv('applyStyleBtn', { style: citStyle }, 'Apply {style} style')) +
      '</button>' +
      '<span class="anvil-export-sep">|</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-rtf">' +
      escapeHtml(anvilT('exportSectionRtf', 'Export Section (RTF)')) +
      '</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-section-docx">' +
      escapeHtml(anvilT('exportSectionWord', 'Export Section (Word)')) +
      '</button>' +
      '<span class="anvil-export-sep">|</span>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-all-rtf">' +
      escapeHtml(anvilT('exportDocRtf', 'Export Document (RTF)')) +
      '</button>' +
      '<button type="button" class="anvil-export-btn" id="anvil-export-all-docx">' +
      escapeHtml(anvilT('exportDocWord', 'Export Document (Word)')) +
      '</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>';

    var extScoring = document.getElementById('anvil-scoring-panel');
    if (extScoring) {
      extScoring.hidden = !!hideScoring;
    }

    mountEditor(draft);
    restoreManuscriptMode();
    feedbackRows = [];
    pendingChange = null;
    hasPendingChange = false;
    lastPlainSent = '';
    hasCompletedInitialReview = false;
    charsSinceFingerprint = 0;
    charsSinceLastSave = 0;
    editorDirty = false;
    ieeeCounter = 0;
    ieeeMap = {};
    renderFeedbackRail();
    if (extScoring && !hideScoring) {
      updateScoring();
    }
    loadSectionSources();
    loadCitationUsages();
    loadFeedbackFromDb();

    document.getElementById('anvil-manual-save').addEventListener('click', function () { saveSectionDraft(); });
    document.getElementById('anvil-paper-toggle').addEventListener('click', togglePaperMode);
    document.getElementById('anvil-apply-style').addEventListener('click', applyWritingStyle);
    document.getElementById('anvil-export-section-rtf').addEventListener('click', exportSectionRtf);
    document.getElementById('anvil-export-section-docx').addEventListener('click', exportSectionDocx);
    document.getElementById('anvil-export-all-rtf').addEventListener('click', exportAllRtf);
    document.getElementById('anvil-export-all-docx').addEventListener('click', exportAllDocx);

    syncAnvilRightRail(current);
    if (isTitleSection(current)) {
      setTimeout(function () {
        maybeShowTitleAccountModal(current);
      }, 120);
    }
    if (isReferenceSection(current)) {
      setTimeout(function () {
        applyReferenceSectionBody(false);
      }, 0);
    }

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
          flushPendingSave();
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
    var conf = e.target.closest('.anvil2-confirm-btn');
    if (conf) {
      e.preventDefault();
      confirmPendingChange();
      return;
    }
    var undo = e.target.closest('.anvil2-undo-btn');
    if (undo) {
      e.preventDefault();
      undoPendingChange();
      return;
    }
    var rp = e.target.closest('.anvil2-research-plan-btn');
    if (rp) {
      e.preventDefault();
      var rpFid = rp.getAttribute('data-fid');
      var rpRow = feedbackRows.find(function (r) { return String(r.item.id) === String(rpFid); });
      if (rpRow) sendToResearchPlan(rpRow);
      return;
    }
    var dis = e.target.closest('.anvil2-dismiss');
    if (dis) {
      e.preventDefault();
      dismissRow(dis.getAttribute('data-dismiss'));
    }
  });

  function flushPendingSave() {
    if (hasPendingChange && pendingChange && quill) {
      undoPendingChange();
    }
    var hadTimer = !!saveTimer;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!editorDirty && !hadTimer) return;
    if (selectedId == null || !bundle || !quill) return;
    var html = getDraftHtml();
    var sec = sectionById(selectedId);
    if (sec) sec.body = html;
    var xhr = new XMLHttpRequest();
    xhr.open('PATCH', '/api/projects/' + projectId + '/sections/' + selectedId, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    try { xhr.send(JSON.stringify({ body: html })); } catch (e) { /* best effort */ }
    charsSinceLastSave = 0;
    editorDirty = false;
  }

  window.addEventListener('beforeunload', flushPendingSave);

  async function load() {
    loadPaperPref();
    root.innerHTML = '<p class="anvil-loading">' + escapeHtml(commonT('loading', 'Loading…')) + '</p>';
    try {
      bundle = await api('/projects/' + projectId, 'GET');
      try {
        var mePayload = await api('/me', 'GET');
        anvilUserProfile = mePayload && mePayload.user ? mePayload.user : null;
      } catch (meErr) {
        anvilUserProfile = null;
      }
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
        '<p class="anvil-error-banner" role="alert">' +
        escapeHtml(anvilTv('loadProjectFailed', { message: e.message || '' }, 'Could not load project. {message}')) +
        '</p>';
      return;
    }
    render();
  }

  var refreshBtn = document.getElementById('anvil-refresh-feedback');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', manualRefreshFeedback);
  }

  var refreshReferencesBtn = document.getElementById('anvil-refresh-references-btn');
  if (refreshReferencesBtn) {
    refreshReferencesBtn.addEventListener('click', function () {
      applyReferenceSectionBody(true);
    });
  }

  var titleModalDismiss = document.getElementById('anvil-title-profile-modal-dismiss');
  var titleModalBackdrop = document.getElementById('anvil-title-profile-modal-backdrop');
  if (titleModalDismiss) titleModalDismiss.addEventListener('click', closeTitleProfileModal);
  if (titleModalBackdrop) titleModalBackdrop.addEventListener('click', closeTitleProfileModal);

  document.addEventListener('click', function (e) {
    if (!document.getElementById('anvil-root')) return;
    var addSrc = e.target.closest('#anvil-add-source-btn');
    if (addSrc) {
      e.preventDefault();
      flushPendingSave();
      window.location.href = '/app/project/' + projectId + '/crucible';
      return;
    }
    var rpRes = e.target.closest('.anvil-rp-resolve');
    if (rpRes) {
      e.preventDefault();
      var rid = parseInt(rpRes.getAttribute('data-anvil-rp-id'), 10);
      if (!Number.isNaN(rid)) updateAnvilResearchPlanStatus(rid, 'resolved');
      return;
    }
    var rpDis = e.target.closest('.anvil-rp-dismiss');
    if (rpDis) {
      e.preventDefault();
      var rid2 = parseInt(rpDis.getAttribute('data-anvil-rp-id'), 10);
      if (!Number.isNaN(rid2)) updateAnvilResearchPlanStatus(rid2, 'dismissed');
    }
  });

  bindPendingChangeModal();
  load();
})();
