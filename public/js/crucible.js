/**
 * The Crucible — sources list + link to project sections (GET/POST/PATCH/DELETE /api/...).
 * Sort (alpha / date), bulk section select, estimated in-text citation counts vs section drafts.
 */
(function () {
  const root = document.getElementById('crucible-root');
  if (!root) return;

  const projectId = parseInt(root.dataset.projectId, 10);
  if (Number.isNaN(projectId)) return;

  const SORT_KEY = 'crucible-sort-' + projectId;

  let sections = [];
  let sources = [];
  let bundle = null;
  let editingId = null;
  let focusTagsAfterEdit = false;
  let showAdd = false;
  let sortMode = 'alpha';
  let relatedResult = null;
  let relatedError = null;
  let relatedLoading = false;
  /** @type {Set<string>} */
  let filterTags = new Set();
  /** @type {Set<number>} */
  let filterSectionIds = new Set();

  try {
    const saved = sessionStorage.getItem(SORT_KEY);
    if (saved === 'date' || saved === 'alpha') sortMode = saved;
  } catch {
    /* ignore */
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;');
  }

  function doiLandingPageUrl(doi) {
    if (doi == null || String(doi).trim() === '') return null;
    const d = String(doi).trim();
    return 'https://doi.org/' + encodeURIComponent(d).replace(/%2F/g, '/');
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

  function projectCitationStyle() {
    if (!bundle || !bundle.project) return 'APA';
    const p = bundle.project;
    const raw = p.citation_style != null ? p.citation_style : p.citationStyle;
    const s = raw != null ? String(raw).trim() : '';
    return s || 'APA';
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

  function htmlToPlain(html) {
    const d = document.createElement('div');
    d.innerHTML = html == null ? '' : String(html);
    return d.textContent || d.innerText || '';
  }

  function linkedSourcesForSection(sectionId, allSources) {
    return allSources
      .filter(function (s) {
        return (s.sectionIds || []).map(Number).includes(Number(sectionId));
      })
      .slice()
      .sort(function (a, b) {
        return String(a.citation_text || '').localeCompare(String(b.citation_text || ''), undefined, {
          sensitivity: 'base',
        });
      });
  }

  function ieeeRank(source, sectionId, allSources) {
    const linked = linkedSourcesForSection(sectionId, allSources);
    const ix = linked.findIndex(function (s) {
      return Number(s.id) === Number(source.id);
    });
    return ix >= 0 ? ix + 1 : null;
  }

  /** Last finished sentence in `text` (ends with . ? !), or empty if none. */
  function lastCompleteSentenceBeforeEnd(text) {
    if (!text || !String(text).trim()) return '';
    const t = String(text);
    let last = '';
    const re = /[^.!?]*[.!?]+(?:\s|$)/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      last = m[0].trim();
    }
    return last;
  }

  /**
   * Entire sentence ending immediately before an in-text citation at `pos`.
   * If the citation opens a sentence, returns the previous full sentence; if none, text before the cite.
   */
  function excerptSentencePrecedingCitation(plain, pos) {
    const before = plain.slice(0, pos);
    const complete = lastCompleteSentenceBeforeEnd(before);
    if (complete) return complete;
    const trimmed = before.trim();
    return trimmed;
  }

  function publicationYearForSort(src) {
    const y = extractYear(src && src.citation_text);
    if (!y) return 0;
    const n = parseInt(y, 10);
    return Number.isNaN(n) ? 0 : n;
  }

  /**
   * Match Anvil insert format; IEEE uses per-section bracket index like the Anvil rail.
   * @returns {{ count: number, sections: { title: string, excerpts: string[] }[] }}
   */
  function estimateInTextUsage(source, allSources, sectionRows) {
    const style = projectCitationStyle().toUpperCase();
    const out = { count: 0, sections: [] };
    if (!sectionRows || !sectionRows.length || !source) return out;

    if (style === 'IEEE') {
      for (let i = 0; i < sectionRows.length; i++) {
        const sec = sectionRows[i];
        const sid = Number(sec.id);
        const linkedIds = (source.sectionIds || []).map(Number);
        if (!linkedIds.includes(sid)) continue;
        const rank = ieeeRank(source, sid, allSources);
        if (rank == null) continue;
        const needle = buildInTextCitation(source.citation_text, style, rank);
        const plain = htmlToPlain(sec.body);
        let pos = 0;
        let n = 0;
        const excerpts = [];
        while ((pos = plain.indexOf(needle, pos)) !== -1) {
          n++;
          if (excerpts.length < 4) {
            excerpts.push(excerptSentencePrecedingCitation(plain, pos));
          }
          pos += needle.length;
        }
        out.count += n;
        if (excerpts.length) {
          out.sections.push({
            title: sec.title || 'Section',
            excerpts: excerpts,
          });
        }
      }
      return out;
    }

    const needle = buildInTextCitation(source.citation_text, style, 1);
    if (!needle) return out;

    for (let i = 0; i < sectionRows.length; i++) {
      const sec = sectionRows[i];
      const plain = htmlToPlain(sec.body);
      let pos = 0;
      let n = 0;
      const excerpts = [];
      while ((pos = plain.indexOf(needle, pos)) !== -1) {
        n++;
        if (excerpts.length < 4) {
          excerpts.push(excerptSentencePrecedingCitation(plain, pos));
        }
        pos += needle.length;
      }
      out.count += n;
      if (excerpts.length) {
        out.sections.push({
          title: sec.title || 'Section',
          excerpts: excerpts,
        });
      }
    }
    return out;
  }

  function parseTagsInput(raw) {
    if (raw == null) return [];
    return String(raw)
      .split(/[,;\n]+/)
      .map(function (t) {
        return t.trim();
      })
      .filter(Boolean);
  }

  function collectAllTags() {
    const out = new Set();
    sources.forEach(function (s) {
      (s.tags || []).forEach(function (t) {
        const x = String(t || '').trim();
        if (x) out.add(x);
      });
    });
    return Array.from(out).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
  }

  function pruneFilterState() {
    const validTags = new Set(collectAllTags());
    Array.from(filterTags).forEach(function (t) {
      if (!validTags.has(t)) filterTags.delete(t);
    });
    const validSec = new Set(
      sections.map(function (s) {
        return Number(s.id);
      })
    );
    Array.from(filterSectionIds).forEach(function (id) {
      if (!validSec.has(id)) filterSectionIds.delete(id);
    });
  }

  function sourcePassesFilters(src) {
    if (filterTags.size > 0) {
      const tags = src.tags || [];
      const hit = Array.from(filterTags).some(function (ft) {
        return tags.some(function (t) {
          return String(t).toLowerCase() === String(ft).toLowerCase();
        });
      });
      if (!hit) return false;
    }
    if (filterSectionIds.size > 0) {
      const ids = (src.sectionIds || []).map(Number);
      const hit = Array.from(filterSectionIds).some(function (fsid) {
        return ids.indexOf(Number(fsid)) >= 0;
      });
      if (!hit) return false;
    }
    return true;
  }

  function filteredSources() {
    return sources.filter(sourcePassesFilters);
  }

  function orderedSources() {
    const copy = filteredSources();
    if (sortMode === 'date') {
      copy.sort(function (a, b) {
        const ta = new Date(a.created_at || a.updated_at || 0).getTime();
        const tb = new Date(b.created_at || b.updated_at || 0).getTime();
        if (tb !== ta) return tb - ta;
        const ya = publicationYearForSort(a);
        const yb = publicationYearForSort(b);
        if (yb !== ya) return yb - ya;
        return Number(a.id) - Number(b.id);
      });
    } else {
      copy.sort(function (a, b) {
        const c = String(a.citation_text || '').localeCompare(String(b.citation_text || ''), undefined, {
          sensitivity: 'base',
        });
        if (c !== 0) return c;
        const ya = publicationYearForSort(a);
        const yb = publicationYearForSort(b);
        if (yb !== ya) return yb - ya;
        return Number(a.id) - Number(b.id);
      });
    }
    return copy;
  }

  async function load() {
    root.innerHTML = '<p class="crucible-loading">Loading sources…</p>';
    try {
      relatedResult = null;
      relatedError = null;
      relatedLoading = false;
      bundle = await api('/projects/' + projectId, 'GET');
      const src = await api('/projects/' + projectId + '/sources', 'GET');
      sections = (bundle && bundle.sections) || [];
      sources = (src && src.sources) || [];
      sources.forEach(function (s) {
        s.tags = Array.isArray(s.tags) ? s.tags : [];
        if (s.crucible_notes == null) s.crucible_notes = '';
      });
      pruneFilterState();
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
      '<fieldset class="crucible-fieldset">' +
      '<div class="crucible-legend-row">' +
      '<span class="crucible-legend">Link to sections</span>' +
      '<span class="crucible-section-bulk">' +
      '<button type="button" class="crucible-btn-mini crucible-sec-all" data-sec-prefix="' +
      escapeHtml(namePrefix) +
      '">All</button>' +
      '<button type="button" class="crucible-btn-mini crucible-sec-none" data-sec-prefix="' +
      escapeHtml(namePrefix) +
      '">None</button>' +
      '</span></div>' +
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

  function openUsageModal(sourceId) {
    const src = sources.find(function (s) {
      return Number(s.id) === Number(sourceId);
    });
    const el = document.getElementById('crucible-modal');
    const body = document.getElementById('crucible-modal-body');
    const title = document.getElementById('crucible-modal-title');
    if (!el || !body || !title || !src) return;

    const usage = estimateInTextUsage(src, sources, sections);
    title.textContent = 'Insertion Points of In-text Citations';

    let html = '<p class="crucible-modal-lead">';
    html +=
      'These are the points where you have applied the in-text citation in your writing. ' +
      'Any manual edits after the insertion may impact these results, producing unexpected results.';
    html += '</p>';
    html +=
      '<p class="crucible-modal-count"><strong>' +
      usage.count +
      '</strong> insertion point' +
      (usage.count === 1 ? '' : 's') +
      '</p>';

    if (!usage.sections.length) {
      html += '<p class="crucible-muted">No matching text found in draft bodies.</p>';
    } else {
      html += '<ul class="crucible-modal-sections">';
      usage.sections.forEach(function (block) {
        const rawTitle = block.title || 'Section';
        const secDisp = rawTitle === 'Discussion' ? 'Insertion Points' : rawTitle;
        html += '<li><div class="crucible-modal-sec-title">' + escapeHtml(secDisp) + '</div>';
        if (rawTitle !== 'Discussion') {
          html += '<div class="crucible-modal-insertion-h">Insertion Points</div>';
        }
        html += '<ul class="crucible-modal-excerpts">';
        block.excerpts.forEach(function (ex) {
          html += '<li>' + escapeHtml(ex) + '</li>';
        });
        html += '</ul></li>';
      });
      html += '</ul>';
    }

    body.innerHTML = html;
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
  }

  function closeUsageModal() {
    const el = document.getElementById('crucible-modal');
    if (!el) return;
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
  }

  function renderRelatedPaperTilesHtml(papers) {
    let h = '<div class="crucible-related-tiles">';
    papers.forEach(function (p) {
      const href = p.url || 'https://www.semanticscholar.org/';
      const title = p.title || 'Untitled';
      const authors = (p.authors || '').trim();
      const year =
        p.year != null && p.year !== '' && !Number.isNaN(Number(p.year)) ? String(p.year) : '';
      const metaBits = [];
      if (authors) metaBits.push(authors);
      if (year) metaBits.push(year);
      const meta = metaBits.join(' · ');
      h += '<a class="crucible-related-tile" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">';
      h += '<div class="crucible-related-tile-title">' + escapeHtml(title) + '</div>';
      if (meta) {
        h += '<div class="crucible-related-tile-meta">' + escapeHtml(meta) + '</div>';
      }
      h += '</a>';
    });
    h += '</div>';
    return h;
  }

  function renderRelatedBodyHtml() {
    if (relatedLoading) {
      return '<p class="crucible-related-status">Fetching related papers (Semantic Scholar, ~1 request/s)…</p>';
    }
    if (relatedError) {
      return '<p class="crucible-related-error" role="alert">' + escapeHtml(relatedError) + '</p>';
    }
    if (!relatedResult) {
      return (
        '<p class="crucible-muted crucible-related-placeholder">Uses your project title and sources for Semantic Scholar (one request at a time, ~1/s). ' +
        'If the first search finds nothing, we may run topic searches via Bedrock and fetch papers for each.</p>'
      );
    }
    const r = relatedResult;
    if (r.source === 'semantic_scholar' && r.papers && r.papers.length) {
      let h = '';
      if (r.paperDiscovery === 'multi_query') {
        h +=
          '<p class="crucible-related-meta">Related articles <span class="crucible-related-query">(from topic searches)</span></p>';
      } else {
        h +=
          '<p class="crucible-related-meta">Matched query: <span class="crucible-related-query">' +
          escapeHtml(r.query || '') +
          '</span></p>';
      }
      h += renderRelatedPaperTilesHtml(r.papers);
      if (r.readingTip) {
        h += '<p class="crucible-related-tip">' + escapeHtml(r.readingTip) + '</p>';
      }
      return h;
    }
    if (r.source === 'bedrock' && r.fallback) {
      let h = '';
      if (r.semanticScholarError) {
        h +=
          '<p class="crucible-muted crucible-related-note">Semantic Scholar: ' +
          escapeHtml(r.semanticScholarError) +
          '</p>';
      }
      h += '<p class="crucible-related-fallback-h">Search ideas (verify in your library)</p>';
      if (r.readingTip) {
        h += '<p class="crucible-related-tip">' + escapeHtml(r.readingTip) + '</p>';
      }
      const qs = r.suggestedQueries || [];
      if (qs.length) {
        h += '<ul class="crucible-related-queries">';
        qs.forEach(function (q) {
          const u = 'https://www.semanticscholar.org/search?q=' + encodeURIComponent(q);
          h +=
            '<li><a href="' +
            escapeHtml(u) +
            '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(q) +
            '</a></li>';
        });
        h += '</ul>';
      } else {
        h += '<p class="crucible-muted">No query lines returned.</p>';
      }
      return h;
    }
    if (r.source === 'bedrock_error') {
      let h = '';
      if (r.semanticScholarError) {
        h +=
          '<p class="crucible-muted">' + escapeHtml(r.semanticScholarError) + '</p>';
      }
      h +=
        '<p class="crucible-related-error" role="alert">' +
        escapeHtml(r.bedrockError || 'Bedrock suggestion failed') +
        '</p>';
      return h;
    }
    return (
      '<p class="crucible-muted">' +
      escapeHtml(r.message || 'No suggestions available.') +
      '</p>'
    );
  }

  function renderResearchNotesTile(src) {
    const id = src.id;
    const raw = src.crucible_notes != null ? String(src.crucible_notes) : '';
    let h = '<div class="crucible-research-notes">';
    h += '<div class="crucible-research-notes-h">Research notes</div>';
    h +=
      '<textarea class="crucible-research-notes-textarea" rows="10" data-source-id="' +
      id +
      '" spellcheck="true" placeholder="Type or paste notes for this source…">' +
      escapeHtml(raw) +
      '</textarea>';
    h += '<div class="crucible-research-notes-footer">';
    h +=
      '<button type="button" class="app-btn-primary crucible-save-notes" data-source-id="' +
      id +
      '">Save notes</button>';
    h +=
      '<span class="crucible-notes-saved-hint" hidden data-for-source="' +
      id +
      '">Saved</span>';
    h += '</div></div>';
    return h;
  }

  function renderFiltersHtml() {
    const allTags = collectAllTags();
    let h = '<div class="crucible-filters" role="region" aria-label="Filter sources">';
    h += '<div class="crucible-filter-row">';
    h += '<span class="crucible-filter-label">Tags</span>';
    h += '<div class="crucible-filter-chips">';
    if (allTags.length === 0) {
      h += '<span class="crucible-muted crucible-filter-empty">No tags yet</span>';
    } else {
      allTags.forEach(function (tag) {
        const active = filterTags.has(tag) ? ' is-active' : '';
        h +=
          '<button type="button" class="crucible-filter-chip' +
          active +
          '" data-filter-kind="tag" data-tag="' +
          escapeAttr(tag) +
          '">' +
          escapeHtml(tag) +
          '</button>';
      });
    }
    h += '</div></div>';
    h += '<div class="crucible-filter-row">';
    h += '<span class="crucible-filter-label">Sections</span>';
    h += '<div class="crucible-filter-chips">';
    if (!sections.length) {
      h += '<span class="crucible-muted crucible-filter-empty">No sections</span>';
    } else {
      sections.forEach(function (sec) {
        const sid = Number(sec.id);
        const active = filterSectionIds.has(sid) ? ' is-active' : '';
        h +=
          '<button type="button" class="crucible-filter-chip' +
          active +
          '" data-filter-kind="section" data-section-id="' +
          sid +
          '">' +
          escapeHtml(sec.title) +
          '</button>';
      });
    }
    h += '</div></div>';
    if (filterTags.size > 0 || filterSectionIds.size > 0) {
      h +=
        '<button type="button" class="crucible-filter-clear" id="crucible-filter-clear">Clear filters</button>';
    }
    h += '</div>';
    return h;
  }

  function render() {
    const errSlot = root.querySelector('.crucible-inline-error');
    const errHtml = errSlot ? errSlot.outerHTML : '';

    let html = '<div class="crucible-panel">';
    html += '<div class="crucible-toolbar crucible-toolbar--split">';
    html +=
      '<button type="button" class="app-btn-primary crucible-add-btn" id="crucible-toggle-add">' +
      (showAdd ? 'Cancel' : 'Add source') +
      '</button>';
    html += '<label class="crucible-sort-label">Sort';
    html +=
      '<select id="crucible-sort" class="crucible-sort-select" aria-label="Sort sources">';
    html +=
      '<option value="alpha"' +
      (sortMode === 'alpha' ? ' selected' : '') +
      '>Alphabetical</option>';
    html +=
      '<option value="date"' +
      (sortMode === 'date' ? ' selected' : '') +
      '>Date added</option>';
    html += '</select></label>';
    html += '</div>';

    html += renderFiltersHtml();

    if (showAdd) {
      html += '<form class="crucible-form" id="crucible-form-add">';
      html += '<label class="crucible-label">Citation <span class="crucible-req">*</span></label>';
      html +=
        '<textarea class="crucible-textarea" name="citationText" rows="4" required placeholder="Full citation or reference text"></textarea>';
      html += '<label class="crucible-label">Citation notes <span class="crucible-optional">(optional)</span></label>';
      html +=
        '<textarea class="crucible-textarea" name="notes" rows="2" placeholder="Short bibliographic notes"></textarea>';
      html +=
        '<label class="crucible-label">DOI <span class="crucible-optional">(optional)</span></label>';
      html +=
        '<input type="text" class="crucible-input" name="doi" autocomplete="off" placeholder="e.g. 10.1038/… or https://doi.org/…" />';
      html +=
        '<label class="crucible-label">Tags <span class="crucible-optional">(optional)</span></label>';
      html +=
        '<input type="text" class="crucible-input" name="tags" autocomplete="off" placeholder="Comma-separated, e.g. meta-analysis, STEM" />';
      html +=
        '<label class="crucible-label">Research notes <span class="crucible-optional">(optional)</span></label>';
      html +=
        '<textarea class="crucible-textarea" name="crucibleNotes" rows="4" placeholder="Freeform notes (plain text; saved with the source)"></textarea>';
      html += renderSectionCheckboxes('addSec', []);
      html += '<div class="crucible-form-actions">';
      html += '<button type="submit" class="app-btn-primary">Save source</button>';
      html += '</div>';
      html += '</form>';
    }

    html += errHtml;

    const displayList = orderedSources();

    if (!displayList.length && !showAdd) {
      if (sources.length && (filterTags.size > 0 || filterSectionIds.size > 0)) {
        html +=
          '<p class="crucible-empty">No sources match the current filters. <button type="button" class="crucible-inline-clear" id="crucible-filter-clear-empty">Clear filters</button></p>';
      } else {
        html +=
          '<p class="crucible-empty">No sources yet. Add a citation to build your bibliography for this project.</p>';
      }
    }

    if (displayList.length) {
      html +=
        '<div class="crucible-split-head" aria-hidden="true"><span class="crucible-split-label">Sources</span><span class="crucible-split-label">Notes</span></div>';
    }
    html += '<ul class="crucible-list crucible-list--split">';
    displayList.forEach(function (src) {
      const isEditing = editingId === src.id;
      const usage = estimateInTextUsage(src, sources, sections);
      html += '<li class="crucible-row" data-source-id="' + src.id + '">';
      html += '<div class="crucible-col crucible-col--source">';
      html += '<div class="crucible-card crucible-card--source">';
      if (isEditing) {
        html += '<form class="crucible-form crucible-edit-form">';
        html += '<label class="crucible-label">Citation</label>';
        html +=
          '<textarea class="crucible-textarea" name="citationText" rows="4" required>' +
          escapeHtml(src.citation_text) +
          '</textarea>';
        html += '<label class="crucible-label">Citation notes <span class="crucible-optional">(optional)</span></label>';
        html +=
          '<textarea class="crucible-textarea" name="notes" rows="2">' +
          escapeHtml(src.notes || '') +
          '</textarea>';
        html +=
          '<label class="crucible-label">DOI <span class="crucible-optional">(optional)</span></label>';
        html +=
          '<input type="text" class="crucible-input" name="doi" autocomplete="off" value="' +
          escapeHtml(src.doi || '') +
          '" placeholder="e.g. 10.1038/… or https://doi.org/…" />';
        html +=
          '<label class="crucible-label">Tags <span class="crucible-optional">(optional)</span></label>';
        html +=
          '<input type="text" class="crucible-input" name="tags" autocomplete="off" value="' +
          escapeHtml((src.tags || []).join(', ')) +
          '" placeholder="Comma-separated" />';
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
        html += '<div class="crucible-card-head">';
        html += '<div class="crucible-citation">' + escapeHtml(src.citation_text) + '</div>';
        html +=
          '<button type="button" class="crucible-cite-count" data-source-id="' +
          src.id +
          '" title="Estimated in-text matches in drafts (click for detail)" aria-label="' +
          escapeHtml(String(usage.count) + ' estimated in-text matches') +
          '">' +
          usage.count +
          '</button>';
        html += '</div>';
        const doiHref = src.doi ? doiLandingPageUrl(src.doi) : null;
        if (doiHref) {
          html +=
            '<div class="crucible-doi-row"><a class="crucible-doi-link" href="' +
            escapeHtml(doiHref) +
            '" target="_blank" rel="noopener noreferrer">Open DOI</a>' +
            '<span class="crucible-doi-id" title="Digital Object Identifier">' +
            escapeHtml(src.doi) +
            '</span></div>';
        }
        if (src.notes) {
          html += '<div class="crucible-notes">' + escapeHtml(src.notes) + '</div>';
        }
        const userTags = src.tags || [];
        if (userTags.length) {
          html += '<div class="crucible-source-tags">';
          userTags.forEach(function (tg) {
            html += '<span class="crucible-source-tag">' + escapeHtml(tg) + '</span>';
          });
          html += '</div>';
        }
        const ids = src.sectionIds || [];
        if (ids.length) {
          html += '<div class="crucible-section-pills">';
          ids.forEach(function (sid) {
            html += '<span class="crucible-section-pill">' + escapeHtml(sectionLabel(sid)) + '</span>';
          });
          html += '</div>';
        }
        html += '<div class="crucible-card-actions crucible-card-actions--split">';
        html += '<div class="crucible-card-actions-left">';
        html +=
          '<button type="button" class="crucible-btn-link crucible-edit" data-id="' +
          src.id +
          '">Edit</button> ';
        html +=
          '<button type="button" class="crucible-btn-link crucible-delete" data-id="' +
          src.id +
          '">Delete</button>';
        html += '</div>';
        html +=
          '<button type="button" class="crucible-btn-link crucible-tags-link" data-id="' +
          src.id +
          '">Tags</button>';
        html += '</div>';
      }
      html += '</div></div>';
      html += '<div class="crucible-col crucible-col--notes">';
      html += '<div class="crucible-card crucible-card--notes">';
      html += renderResearchNotesTile(src);
      html += '</div></div>';
      html += '</li>';
    });
    html += '</ul>';

    html += '<div id="crucible-modal" class="crucible-modal" hidden aria-hidden="true">';
    html += '<div class="crucible-modal-backdrop" tabindex="-1"></div>';
    html += '<div class="crucible-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="crucible-modal-title">';
    html += '<div class="crucible-modal-header">';
    html += '<h2 id="crucible-modal-title" class="crucible-modal-h">Insertion Points of In-text Citations</h2>';
    html +=
      '<button type="button" class="crucible-modal-close" aria-label="Close dialog">&times;</button>';
    html += '</div>';
    html += '<div id="crucible-modal-body" class="crucible-modal-body"></div>';
    html += '</div></div>';

    html += '</div>';

    root.innerHTML = html;
    syncRelatedRail();
    bind();
  }

  function syncRelatedRail() {
    const mount = document.getElementById('crucible-related-rail-mount');
    if (mount) {
      mount.innerHTML = renderRelatedBodyHtml();
    }
    const fetchBtn = document.getElementById('crucible-related-fetch');
    if (fetchBtn) {
      fetchBtn.disabled = !!relatedLoading;
    }
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
    const sortSel = document.getElementById('crucible-sort');
    if (sortSel) {
      sortSel.addEventListener('change', function () {
        sortMode = sortSel.value === 'date' ? 'date' : 'alpha';
        try {
          sessionStorage.setItem(SORT_KEY, sortMode);
        } catch {
          /* ignore */
        }
        clearError();
        render();
      });
    }

    root.querySelectorAll('.crucible-sec-all, .crucible-sec-none').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const prefix = btn.getAttribute('data-sec-prefix');
        if (!prefix) return;
        const all = btn.classList.contains('crucible-sec-all');
        const form = btn.closest('form');
        if (!form) return;
        form.querySelectorAll('input[type="checkbox"][name="' + prefix + '"]').forEach(function (cb) {
          cb.checked = all;
        });
      });
    });

    root.querySelectorAll('.crucible-cite-count').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const sid = parseInt(btn.getAttribute('data-source-id'), 10);
        if (!Number.isNaN(sid)) openUsageModal(sid);
      });
    });

    const relatedFetch = document.getElementById('crucible-related-fetch');
    if (relatedFetch) {
      relatedFetch.addEventListener('click', async function () {
        relatedLoading = true;
        relatedError = null;
        relatedResult = null;
        render();
        try {
          relatedResult = await api('/projects/' + projectId + '/related-reading', 'GET');
          relatedError = null;
        } catch (e) {
          relatedError = e.message || 'Could not load suggestions.';
          relatedResult = null;
        }
        relatedLoading = false;
        render();
      });
    }

    const modal = document.getElementById('crucible-modal');
    if (modal) {
      modal.querySelectorAll('.crucible-modal-backdrop, .crucible-modal-close').forEach(function (el) {
        el.addEventListener('click', closeUsageModal);
      });
    }

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
        const doiRaw = (fd.get('doi') || '').toString().trim();
        const sectionIds = collectSectionIds(formAdd, 'addSec');
        const tags = parseTagsInput(fd.get('tags'));
        const crucibleNotesRaw = (fd.get('crucibleNotes') || '').toString();
        const crucibleNotes = crucibleNotesRaw.trim() === '' ? null : crucibleNotesRaw;
        try {
          await api('/projects/' + projectId + '/sources', 'POST', {
            citationText,
            notes,
            doi: doiRaw || null,
            sectionIds,
            tags,
            crucibleNotes,
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
        focusTagsAfterEdit = false;
        showAdd = false;
        clearError();
        render();
      });
    });

    root.querySelectorAll('.crucible-tags-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingId = parseInt(btn.getAttribute('data-id'), 10);
        focusTagsAfterEdit = true;
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
        const row = form.closest('.crucible-row');
        const id = row ? parseInt(row.getAttribute('data-source-id'), 10) : NaN;
        if (Number.isNaN(id)) return;
        clearError();
        const fd = new FormData(form);
        const citationText = (fd.get('citationText') || '').toString().trim();
        const notes = (fd.get('notes') || '').toString();
        const doiRaw = (fd.get('doi') || '').toString().trim();
        const sectionIds = collectSectionIds(form, 'editSec-' + id);
        const tags = parseTagsInput(fd.get('tags'));
        const taNotes = row && row.querySelector('.crucible-research-notes-textarea');
        let crucibleNotes = undefined;
        if (taNotes) {
          const v = taNotes.value;
          crucibleNotes = v.trim() === '' ? null : v;
        }
        try {
          await api('/sources/' + id, 'PATCH', {
            citationText,
            notes: notes === '' ? null : notes,
            doi: doiRaw,
            sectionIds,
            tags,
            crucibleNotes,
          });
          editingId = null;
          await load();
        } catch (e) {
          showError(e.message);
        }
      });
    });

    root.querySelectorAll('.crucible-save-notes').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const id = parseInt(btn.getAttribute('data-source-id'), 10);
        if (Number.isNaN(id)) return;
        const ta = root.querySelector('.crucible-research-notes-textarea[data-source-id="' + id + '"]');
        if (!ta) return;
        clearError();
        btn.disabled = true;
        const v = ta.value;
        const crucibleNotes = v.trim() === '' ? null : v;
        try {
          await api('/sources/' + id, 'PATCH', { crucibleNotes });
          const src = sources.find(function (s) {
            return Number(s.id) === id;
          });
          if (src) src.crucible_notes = crucibleNotes == null ? '' : crucibleNotes;
          const hint = root.querySelector('.crucible-notes-saved-hint[data-for-source="' + id + '"]');
          if (hint) {
            hint.hidden = false;
            setTimeout(function () {
              hint.hidden = true;
            }, 2000);
          }
        } catch (e) {
          showError(e.message);
        } finally {
          btn.disabled = false;
        }
      });
    });

    if (focusTagsAfterEdit && editingId) {
      const row = root.querySelector('.crucible-row[data-source-id="' + editingId + '"]');
      const tagsInput = row && row.querySelector('.crucible-col--source input[name="tags"]');
      if (tagsInput) {
        tagsInput.focus();
        tagsInput.select();
      }
      focusTagsAfterEdit = false;
    }
  }

  root.addEventListener('click', function (ev) {
    const chip = ev.target.closest('.crucible-filter-chip');
    if (chip && root.contains(chip)) {
      const kind = chip.getAttribute('data-filter-kind');
      if (kind === 'tag') {
        const t = chip.getAttribute('data-tag');
        if (t == null || t === '') return;
        if (filterTags.has(t)) filterTags.delete(t);
        else filterTags.add(t);
      } else if (kind === 'section') {
        const sid = parseInt(chip.getAttribute('data-section-id'), 10);
        if (Number.isNaN(sid)) return;
        if (filterSectionIds.has(sid)) filterSectionIds.delete(sid);
        else filterSectionIds.add(sid);
      }
      clearError();
      render();
      return;
    }
    if (ev.target.closest('#crucible-filter-clear, #crucible-filter-clear-empty')) {
      filterTags.clear();
      filterSectionIds.clear();
      clearError();
      render();
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    const m = document.getElementById('crucible-modal');
    if (!m || m.hidden) return;
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
  });

  load();
})();
