(function () {
  var typeEl = document.getElementById('rs2-type');
  var runBtn = document.getElementById('rs2-run');
  var loadSavedBtn = document.getElementById('rs2-load-saved');
  var statusEl = document.getElementById('rs2-status');
  var progressEl = document.getElementById('rs2-progress');
  var warnZeroEl = document.getElementById('rs2-warn-zero');
  var warnErrEl = document.getElementById('rs2-warn-err');
  var resultsEl = document.getElementById('rs2-results');
  var statsEl = document.getElementById('rs2-stats');
  var chartConstructsEl = document.getElementById('rs2-chart-constructs');
  var chartYearsEl = document.getElementById('rs2-chart-years');
  var tbodyEl = document.getElementById('rs2-tbody');

  var lastCorpus = [];
  var lastStats = null;
  var sortState = { key: 'relevance_score', dir: 'desc' };

  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = cls || '';
  }

  /** Avoid opaque "Unexpected token '<'" when the server returns an HTML error/login page. */
  function parseFetchJson(r) {
    return r.text().then(function (text) {
      var t = String(text || '').replace(/^\uFEFF/, '').trim();
      if (!t) return {};
      if (t.charAt(0) === '<') {
        throw new Error(
          'Server returned a web page instead of JSON (HTTP ' +
            r.status +
            '). Refresh, sign in again, or check deployment and the /api URL.'
        );
      }
      try {
        return JSON.parse(t);
      } catch (e) {
        throw new Error('Invalid JSON from server (HTTP ' + r.status + '): ' + (e.message || e));
      }
    });
  }

  function parseSSEStream(textChunk, carry) {
    var events = [];
    var buf = (carry.buf || '') + textChunk;
    var parts = buf.split('\n\n');
    carry.buf = parts.pop() || '';
    for (var i = 0; i < parts.length; i++) {
      var block = parts[i].trim();
      if (block.indexOf('data: ') === 0) {
        try {
          events.push(JSON.parse(block.slice(6)));
        } catch (e) {
          /* ignore */
        }
      }
    }
    return events;
  }

  function formatProgress(ev) {
    if (!ev || ev.event !== 'progress') return '';
    var api = ev.api === 'semantic_scholar' ? 'Semantic Scholar' : 'OpenAlex';
    return (
      'Running query ' +
      ev.index +
      ' of ' +
      ev.total +
      ' against ' +
      api +
      ': ' +
      (ev.purpose || '')
    );
  }

  function authorsShort(authors) {
    if (!authors || !authors.length) return '';
    var first = authors[0].name || '';
    if (authors.length === 1) return first;
    return first + ' et al.';
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderSummary(stats) {
    var sb = '';
    sb +=
      '<div><strong>Total retrieved (before dedup)</strong>' +
      (stats.total_retrieved_before_dedup != null ? stats.total_retrieved_before_dedup : '—') +
      '</div>';
    sb +=
      '<div><strong>After dedup</strong>' +
      (stats.total_after_dedup != null ? stats.total_after_dedup : '—') +
      '</div>';
    sb +=
      '<div><strong>Final corpus</strong>' +
      (stats.total_after_trimming != null ? stats.total_after_trimming : '—') +
      '</div>';
    var br = stats.source_breakdown || {};
    sb +=
      '<div><strong>Sources</strong> OpenAlex only ' +
      (br.openalex_only != null ? br.openalex_only : '—') +
      ', S2 only ' +
      (br.semantic_scholar_only != null ? br.semantic_scholar_only : '—') +
      ', both ' +
      (br.both != null ? br.both : '—') +
      '</div>';
    statsEl.innerHTML = sb;
  }

  function renderConstructBars(ppc) {
    chartConstructsEl.innerHTML = '';
    var labels = Object.keys(ppc || {});
    if (!labels.length) {
      chartConstructsEl.textContent = 'No data.';
      return;
    }
    var max = Math.max.apply(null, labels.map(function (k) {
      return ppc[k] || 0;
    }));
    if (max <= 0) max = 1;
    labels.forEach(function (label) {
      var n = ppc[label] || 0;
      var pct = (n / max) * 100;
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML =
        '<span class="bar-label" title="' +
        esc(label) +
        '">' +
        esc(label) +
        '</span><div class="bar-track"><div class="bar-fill" style="width:' +
        pct +
        '%"></div></div><span class="bar-count">' +
        n +
        '</span>';
      chartConstructsEl.appendChild(row);
    });
  }

  function renderYearHist(yd) {
    chartYearsEl.innerHTML = '';
    var years = Object.keys(yd || {})
      .map(function (y) {
        return parseInt(y, 10);
      })
      .filter(function (y) {
        return !isNaN(y);
      })
      .sort(function (a, b) {
        return a - b;
      });
    if (!years.length) {
      chartYearsEl.textContent = 'No year data.';
      return;
    }
    var counts = years.map(function (y) {
      return yd[String(y)] || 0;
    });
    var max = Math.max.apply(null, counts);
    if (max <= 0) max = 1;
    var wrap = document.createElement('div');
    wrap.className = 'hist-row';
    years.forEach(function (y, i) {
      var c = counts[i];
      var h = (c / max) * 100;
      var col = document.createElement('div');
      col.className = 'hist-col';
      col.innerHTML =
        '<div class="hist-bar" style="height:' +
        h +
        '%" title="' +
        y +
        ': ' +
        c +
        '"></div><span class="hist-year">' +
        y +
        '</span>';
      wrap.appendChild(col);
    });
    chartYearsEl.appendChild(wrap);
  }

  function getSortVal(p, key) {
    if (key === 'authors') return authorsShort(p.authors).toLowerCase();
    if (key === 'constructs') return ((p.constructs_covered || []) || []).join(', ').toLowerCase();
    if (key === 'relevance_score') return p.relevance_score != null ? Number(p.relevance_score) : 0;
    if (key === 'year') return p.year != null ? Number(p.year) : -9999;
    return String(p[key] == null ? '' : p[key]).toLowerCase();
  }

  function sortCorpusRows(rows, key, dir) {
    var copy = rows.slice();
    copy.sort(function (a, b) {
      var va = getSortVal(a, key);
      var vb = getSortVal(b, key);
      if (typeof va === 'number' && typeof vb === 'number') {
        return dir === 'asc' ? va - vb : vb - va;
      }
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }

  function renderTable(rows) {
    tbodyEl.innerHTML = '';
    var sorted = sortCorpusRows(rows, sortState.key, sortState.dir);
    sorted.forEach(function (p) {
      var tr = document.createElement('tr');
      var cc = (p.constructs_covered || []).join(', ');
      if (cc.length > 160) cc = cc.slice(0, 157) + '…';
      tr.innerHTML =
        '<td class="num">' +
        (p.relevance_score != null ? Number(p.relevance_score).toFixed(4) : '') +
        '</td><td>' +
        esc(p.title) +
        '</td><td>' +
        esc(authorsShort(p.authors)) +
        '</td><td class="num">' +
        esc(p.year != null ? String(p.year) : '') +
        '</td><td>' +
        esc(p.venue || '') +
        '</td><td>' +
        esc(cc) +
        '</td>';
      tbodyEl.appendChild(tr);
    });
    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.getAttribute('data-sort') === sortState.key) {
        th.classList.add(sortState.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  document.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (sortState.key === k) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = k;
        sortState.dir = k === 'title' || k === 'authors' || k === 'venue' || k === 'constructs' ? 'asc' : 'desc';
      }
      renderTable(lastCorpus);
    });
  });

  function renderResult(result) {
    var stats = result.statistics || {};
    lastStats = stats;
    lastCorpus = result.corpus || [];

    var z = stats.zero_result_queries || [];
    if (z.length) {
      warnZeroEl.textContent =
        'No results from either API for ' +
        z.length +
        ' quer' +
        (z.length === 1 ? 'y' : 'ies') +
        ': ' +
        z.join('; ');
      warnZeroEl.classList.remove('rs2-hidden');
    } else {
      warnZeroEl.classList.add('rs2-hidden');
    }

    var qe = stats.query_errors || [];
    if (qe.length) {
      var parts = qe.map(function (x) {
        return (x.purpose || '') + ' (' + (x.api || '') + '): ' + (x.error || '').slice(0, 120);
      });
      warnErrEl.textContent = 'Some API requests failed (retrieval continued): ' + parts.join(' | ');
      warnErrEl.classList.remove('rs2-hidden');
    } else {
      warnErrEl.classList.add('rs2-hidden');
    }

    renderSummary(stats);
    renderConstructBars(stats.papers_per_construct || {});
    renderYearHist(stats.year_distribution || {});
    sortState = { key: 'relevance_score', dir: 'desc' };
    renderTable(lastCorpus);
    resultsEl.classList.remove('rs2-hidden');
  }

  function handleEvent(ev) {
    if (!ev || !ev.event) return;
    if (ev.event === 'progress') {
      progressEl.textContent = formatProgress(ev);
    } else if (ev.event === 'done' && ev.result) {
      progressEl.textContent = '';
      setStatus('Retrieval complete. Corpus saved for Enrichment.', 'ok');
      renderResult(ev.result);
    } else if (ev.event === 'error') {
      progressEl.textContent = '';
      setStatus(ev.message || 'Error', 'err');
    }
  }

  runBtn.addEventListener('click', function () {
    runBtn.disabled = true;
    loadSavedBtn.disabled = true;
    setStatus('Retrieving…', '');
    progressEl.textContent = '';
    resultsEl.classList.add('rs2-hidden');
    warnZeroEl.classList.add('rs2-hidden');
    warnErrEl.classList.add('rs2-hidden');

    var projectType = (typeEl && typeEl.value) || 'dissertation';

    fetch('/api/admin/research-stage2-run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ projectType: projectType }),
    })
      .then(function (r) {
        if (!r.ok) {
          return parseFetchJson(r).then(function (err) {
            throw new Error((err && err.error) || 'Request failed (HTTP ' + r.status + ')');
          });
        }
        var reader = r.body.getReader();
        var dec = new TextDecoder();
        var carry = { buf: '' };
        function pump() {
          return reader.read().then(function (ref) {
            if (ref.done) {
              if (carry.buf.trim()) {
                var tail = parseSSEStream(carry.buf + '\n\n', { buf: '' });
                for (var j = 0; j < tail.length; j++) {
                  handleEvent(tail[j]);
                }
              }
              return null;
            }
            var chunk = dec.decode(ref.value, { stream: true });
            var events = parseSSEStream(chunk, carry);
            for (var i = 0; i < events.length; i++) {
              handleEvent(events[i]);
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        setStatus(e.message || 'Failed', 'err');
      })
      .then(function () {
        runBtn.disabled = false;
        loadSavedBtn.disabled = false;
      });
  });

  fetch('/api/admin/research-stage1-latest-plan', { credentials: 'same-origin' })
    .then(function (r) {
      return parseFetchJson(r);
    })
    .then(function (data) {
      if (!data.ok || !data.plan || !typeEl) return;
      var pt = data.plan.project_type;
      if (pt && ['assignment', 'dissertation', 'conference', 'journal'].indexOf(pt) >= 0) {
        typeEl.value = pt;
      }
    })
    .catch(function () {
      /* ignore */
    });

  loadSavedBtn.addEventListener('click', function () {
    setStatus('Loading…', '');
    fetch('/api/admin/research-stage2-latest', { credentials: 'same-origin' })
      .then(function (r) {
        return parseFetchJson(r);
      })
      .then(function (data) {
        if (!data.ok || !data.hasData) {
          setStatus('No saved corpus yet. Run retrieval first.', 'err');
          return;
        }
        if (data.project_type && typeEl) typeEl.value = data.project_type;
        setStatus('Loaded saved corpus.', 'ok');
        renderResult({ corpus: data.corpus, statistics: data.statistics });
      })
      .catch(function (e) {
        setStatus(e.message || 'Failed', 'err');
      });
  });
})();
