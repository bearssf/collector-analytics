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
  let showAdd = false;
  let sortMode = 'alpha';
  let relatedResult = null;
  let relatedError = null;
  let relatedLoading = false;

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

  function excerptAround(plain, needle, idx, pad) {
    const start = Math.max(0, idx - pad);
    const end = Math.min(plain.length, idx + needle.length + pad);
    return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
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
            excerpts.push(excerptAround(plain, needle, pos, 52));
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
          excerpts.push(excerptAround(plain, needle, pos, 52));
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

  function orderedSources() {
    const copy = sources.slice();
    if (sortMode === 'date') {
      copy.sort(function (a, b) {
        const ta = new Date(a.created_at || a.updated_at || 0).getTime();
        const tb = new Date(b.created_at || b.updated_at || 0).getTime();
        return tb - ta;
      });
    } else {
      copy.sort(function (a, b) {
        return String(a.citation_text || '').localeCompare(String(b.citation_text || ''), undefined, {
          sensitivity: 'base',
        });
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
    title.textContent = 'In-text matches for this source';

    let html = '<p class="crucible-modal-lead">';
    html +=
      'Estimated matches of the project’s in-text format in your section drafts. ' +
      'Manual edits or other wording may differ.';
    html += '</p>';
    html += '<p class="crucible-modal-count"><strong>' + usage.count + '</strong> match' + (usage.count === 1 ? '' : 'es') + '</p>';

    if (!usage.sections.length) {
      html += '<p class="crucible-muted">No matching text found in draft bodies.</p>';
    } else {
      html += '<ul class="crucible-modal-sections">';
      usage.sections.forEach(function (block) {
        html += '<li><div class="crucible-modal-sec-title">' + escapeHtml(block.title) + '</div>';
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

  function renderRelatedBodyHtml() {
    if (relatedLoading) {
      return '<p class="crucible-related-status">Searching Semantic Scholar…</p>';
    }
    if (relatedError) {
      return '<p class="crucible-related-error" role="alert">' + escapeHtml(relatedError) + '</p>';
    }
    if (!relatedResult) {
      return (
        '<p class="crucible-muted crucible-related-placeholder">Uses your project title and sources in one Semantic Scholar search (rate-limited). ' +
        'If no papers match or the API is busy, we can suggest search phrases via Bedrock when configured.</p>'
      );
    }
    const r = relatedResult;
    if (r.source === 'semantic_scholar' && r.papers && r.papers.length) {
      let h =
        '<p class="crucible-related-meta">Search: <span class="crucible-related-query">' +
        escapeHtml(r.query || '') +
        '</span></p>';
      h += '<ul class="crucible-related-list">';
      r.papers.forEach(function (p) {
        h += '<li class="crucible-related-paper">';
        h += '<div class="crucible-related-paper-title">' + escapeHtml(p.title || 'Untitled') + '</div>';
        h += '<div class="crucible-related-paper-sub">';
        if (p.year) h += escapeHtml(String(p.year)) + ' · ';
        h += escapeHtml(p.authors || '') + '</div>';
        if (p.abstract) {
          h += '<p class="crucible-related-abstract">' + escapeHtml(p.abstract) + '</p>';
        }
        if (p.url) {
          h +=
            '<a class="crucible-related-external" href="' +
            escapeHtml(p.url) +
            '" target="_blank" rel="noopener noreferrer">Open on Semantic Scholar</a>';
        }
        h += '</li>';
      });
      h += '</ul>';
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

    if (showAdd) {
      html += '<form class="crucible-form" id="crucible-form-add">';
      html += '<label class="crucible-label">Citation <span class="crucible-req">*</span></label>';
      html +=
        '<textarea class="crucible-textarea" name="citationText" rows="4" required placeholder="Full citation or reference text"></textarea>';
      html += '<label class="crucible-label">Notes</label>';
      html += '<textarea class="crucible-textarea" name="notes" rows="2" placeholder="Optional notes"></textarea>';
      html +=
        '<label class="crucible-label">DOI <span class="crucible-optional">(optional)</span></label>';
      html +=
        '<input type="text" class="crucible-input" name="doi" autocomplete="off" placeholder="e.g. 10.1038/… or https://doi.org/…" />';
      html += renderSectionCheckboxes('addSec', []);
      html += '<div class="crucible-form-actions">';
      html += '<button type="submit" class="app-btn-primary">Save source</button>';
      html += '</div>';
      html += '</form>';
    }

    html += errHtml;

    html += '<section class="crucible-related" aria-labelledby="crucible-related-heading">';
    html += '<div class="crucible-related-head">';
    html += '<h2 id="crucible-related-heading" class="crucible-related-heading">Related reading</h2>';
    html +=
      '<button type="button" class="crucible-btn-secondary crucible-related-fetch" id="crucible-related-fetch"' +
      (relatedLoading ? ' disabled' : '') +
      '>Get suggestions</button>';
    html += '</div>';
    html += '<div class="crucible-related-body">' + renderRelatedBodyHtml() + '</div>';
    html += '</section>';

    const displayList = orderedSources();

    if (!displayList.length && !showAdd) {
      html += '<p class="crucible-empty">No sources yet. Add a citation to build your bibliography for this project.</p>';
    }

    html += '<ul class="crucible-list">';
    displayList.forEach(function (src) {
      const isEditing = editingId === src.id;
      const usage = estimateInTextUsage(src, sources, sections);
      html += '<li class="crucible-card" data-source-id="' + src.id + '">';
      if (isEditing) {
        html += '<form class="crucible-form crucible-edit-form">';
        html += '<label class="crucible-label">Citation</label>';
        html +=
          '<textarea class="crucible-textarea" name="citationText" rows="4" required>' +
          escapeHtml(src.citation_text) +
          '</textarea>';
        html += '<label class="crucible-label">Notes</label>';
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
        const ids = src.sectionIds || [];
        if (ids.length) {
          html += '<div class="crucible-tags">';
          ids.forEach(function (sid) {
            html += '<span class="crucible-tag">' + escapeHtml(sectionLabel(sid)) + '</span>';
          });
          html += '</div>';
        }
        html += '<div class="crucible-card-actions">';
        html +=
          '<button type="button" class="crucible-btn-link crucible-edit" data-id="' +
          src.id +
          '">Edit</button> ';
        html +=
          '<button type="button" class="crucible-btn-link crucible-delete" data-id="' +
          src.id +
          '">Delete</button>';
        html += '</div>';
      }
      html += '</li>';
    });
    html += '</ul>';

    html += '<div id="crucible-modal" class="crucible-modal" hidden aria-hidden="true">';
    html += '<div class="crucible-modal-backdrop" tabindex="-1"></div>';
    html += '<div class="crucible-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="crucible-modal-title">';
    html += '<div class="crucible-modal-header">';
    html += '<h2 id="crucible-modal-title" class="crucible-modal-h">In-text usage</h2>';
    html +=
      '<button type="button" class="crucible-modal-close" aria-label="Close dialog">&times;</button>';
    html += '</div>';
    html += '<div id="crucible-modal-body" class="crucible-modal-body"></div>';
    html += '</div></div>';

    html += '</div>';

    root.innerHTML = html;
    bind();
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
        try {
          await api('/projects/' + projectId + '/sources', 'POST', {
            citationText,
            notes,
            doi: doiRaw || null,
            sectionIds,
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
        const card = form.closest('.crucible-card');
        const id = card ? parseInt(card.getAttribute('data-source-id'), 10) : NaN;
        if (Number.isNaN(id)) return;
        clearError();
        const fd = new FormData(form);
        const citationText = (fd.get('citationText') || '').toString().trim();
        const notes = (fd.get('notes') || '').toString();
        const doiRaw = (fd.get('doi') || '').toString().trim();
        const sectionIds = collectSectionIds(form, 'editSec-' + id);
        try {
          await api('/sources/' + id, 'PATCH', {
            citationText,
            notes: notes === '' ? null : notes,
            doi: doiRaw,
            sectionIds,
          });
          editingId = null;
          await load();
        } catch (e) {
          showError(e.message);
        }
      });
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    const m = document.getElementById('crucible-modal');
    if (!m || m.hidden) return;
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
  });

  load();
})();
