(function () {
  var typeEl = document.getElementById('rs2-type');
  var runBtn = document.getElementById('rs2-run');
  var loadSavedBtn = document.getElementById('rs2-load-saved');
  var statusEl = document.getElementById('rs2-status');
  var progressEl = document.getElementById('rs2-progress');
  var stackEl = document.getElementById('rs2-stack');
  var stackWrapEl = document.getElementById('rs2-stack-wrap');
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

  var runTimerId = null;
  var phaseTimerId = null;
  var runStartedAt = 0;
  var lastStepAt = 0;
  var phaseStartedAt = 0;
  var progressLineBase = '';

  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = cls || '';
  }

  function formatDuration(sec) {
    if (sec < 0 || !isFinite(sec)) return '0s';
    if (sec < 60) return sec.toFixed(1) + 's';
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + 'm ' + (s < 10 ? '0' : '') + s.toFixed(0) + 's';
  }

  function stopRunTimers() {
    if (runTimerId) {
      clearInterval(runTimerId);
      runTimerId = null;
    }
    if (phaseTimerId) {
      clearInterval(phaseTimerId);
      phaseTimerId = null;
    }
  }

  function tickTotalElapsed() {
    if (!runStartedAt) return;
    statusEl.textContent = 'Retrieving… · Run time ' + formatDuration((Date.now() - runStartedAt) / 1000);
    statusEl.className = '';
  }

  function startRunElapsedTimer() {
    stopRunTimers();
    runStartedAt = Date.now();
    lastStepAt = runStartedAt;
    tickTotalElapsed();
    runTimerId = setInterval(tickTotalElapsed, 500);
  }

  function refreshPhaseProgressLine() {
    if (!progressLineBase) return;
    var stepSec = phaseStartedAt ? (Date.now() - phaseStartedAt) / 1000 : 0;
    progressEl.textContent = progressLineBase + ' · This step: ' + formatDuration(stepSec);
  }

  function startPhaseStopwatch(baseText) {
    progressLineBase = baseText || '';
    phaseStartedAt = Date.now();
    if (phaseTimerId) {
      clearInterval(phaseTimerId);
    }
    refreshPhaseProgressLine();
    phaseTimerId = setInterval(refreshPhaseProgressLine, 250);
  }

  function pausePhaseStopwatch() {
    if (phaseTimerId) {
      clearInterval(phaseTimerId);
      phaseTimerId = null;
    }
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
    var parts = [
      'In flight: query ' + ev.index + ' / ' + ev.total + ' · ' + api,
      ev.purpose ? 'Purpose: ' + ev.purpose : '',
    ];
    if (ev.keyword_preview) {
      parts.push('Keywords: ' + ev.keyword_preview);
    }
    if (ev.api !== 'semantic_scholar') {
      if (ev.openalex_concept_filters != null && ev.openalex_concept_filters > 0) {
        parts.push(ev.openalex_concept_filters + ' OpenAlex concept ID filter(s)');
      }
      if (ev.openalex_concepts && ev.openalex_concepts.length) {
        var labs = ev.openalex_concepts.slice(0, 4).join(', ');
        if (ev.openalex_concepts.length > 4) {
          labs += ' …';
        }
        parts.push('Concept labels: ' + labs);
      }
      if (ev.year_filter && ev.year_filter !== 'none') {
        parts.push('Years: ' + ev.year_filter);
      }
    }
    return parts.filter(Boolean).join(' — ');
  }

  function clearActivityStack() {
    if (stackEl) stackEl.innerHTML = '';
    if (stackWrapEl) stackWrapEl.classList.add('rs2-hidden');
  }

  function showActivityStack() {
    if (stackWrapEl) stackWrapEl.classList.remove('rs2-hidden');
  }

  function appendActivityEntry(entry, stepSeconds, totalRunSeconds) {
    if (!stackEl || !entry) return;
    showActivityStack();
    var item = document.createElement('div');
    var kind = String(entry.kind || 'step').replace(/[^a-z0-9_-]/gi, '_');
    item.className = 'stack-item stack-' + kind;
    var title = document.createElement('div');
    title.className = 'stack-title';
    title.textContent = entry.title || '';
    item.appendChild(title);
    if (stepSeconds != null && isFinite(stepSeconds) && totalRunSeconds != null && isFinite(totalRunSeconds)) {
      var meta = document.createElement('div');
      meta.className = 'stack-step-meta';
      meta.textContent =
        'Step time ' + formatDuration(stepSeconds) + ' · Run total ' + formatDuration(totalRunSeconds);
      item.appendChild(meta);
    }
    var ul = document.createElement('ul');
    ul.className = 'stack-bullets';
    (entry.bullets || []).forEach(function (b) {
      var li = document.createElement('li');
      li.textContent = b;
      ul.appendChild(li);
    });
    item.appendChild(ul);
    stackEl.appendChild(item);
    stackEl.scrollTop = stackEl.scrollHeight;
  }

  function renderActivityLog(log) {
    clearActivityStack();
    if (!log || !log.length) return;
    showActivityStack();
    for (var i = 0; i < log.length; i++) {
      appendActivityEntry(log[i], null, null);
    }
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
    var pairs = [];
    Object.keys(yd || {}).forEach(function (k) {
      var y = parseInt(k, 10);
      var c = Number(yd[k]);
      if (!isNaN(y) && isFinite(c)) {
        pairs.push({ y: y, c: c });
      }
    });
    pairs.sort(function (a, b) {
      return a.y - b.y;
    });
    var years = pairs.map(function (p) {
      return p.y;
    });
    var counts = pairs.map(function (p) {
      return p.c;
    });
    if (!years.length) {
      chartYearsEl.textContent = 'No year data.';
      return;
    }
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

  function renderQueryTrace(qt) {
    var wrap = document.getElementById('rs2-query-trace-wrap');
    var host = document.getElementById('rs2-query-trace');
    if (!wrap || !host) return;
    host.innerHTML = '';
    if (!qt || !qt.length) {
      wrap.classList.add('rs2-hidden');
      return;
    }
    wrap.classList.remove('rs2-hidden');
    var table = document.createElement('table');
    table.className = 'rs2-trace-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['#', 'Purpose', 'OpenAlex', 'S2', 'Per-API log'].forEach(function (h, idx) {
      var th = document.createElement('th');
      if (idx === 0 || idx === 2 || idx === 3) th.className = 'num';
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tb = document.createElement('tbody');
    qt.forEach(function (row) {
      var oa = row.openalex || {};
      var s2 = row.semantic_scholar || {};
      var oaN =
        row.openalex_count != null ? row.openalex_count : oa.total_returned != null ? oa.total_returned : '—';
      var s2N =
        row.semantic_scholar_count != null
          ? row.semantic_scholar_count
          : s2.total_returned != null
            ? s2.total_returned
            : '—';
      var tr = document.createElement('tr');
      var td0 = document.createElement('td');
      td0.className = 'num';
      td0.textContent = String(row.index != null ? row.index : '');
      var td1 = document.createElement('td');
      td1.textContent = row.purpose || '';
      var td2 = document.createElement('td');
      td2.className = 'num';
      td2.textContent = String(oaN);
      var td3 = document.createElement('td');
      td3.className = 'num';
      td3.textContent = String(s2N);
      var td4 = document.createElement('td');
      td4.className = 'trace-detail';
      var lines = [];
      if (oa.keyword_query_preview) {
        lines.push('OA search preview: ' + oa.keyword_query_preview.slice(0, 220));
      }
      if (oa.relaxed_no_concept_fetch) {
        lines.push(
          'OA supplemental keyword-only pass added ' + (oa.relaxed_additional || 0) + ' (strict concept filter yielded few hits).'
        );
      }
      if (oa.pages && oa.pages.length) {
        oa.pages.forEach(function (pg, j) {
          if (pg.error) {
            lines.push('OpenAlex page ' + (j + 1) + ' error: ' + String(pg.error).slice(0, 200));
          } else if (pg.http_ok) {
            lines.push(
              'OpenAlex page ' +
                (j + 1) +
                ': +' +
                (pg.batch_returned || 0) +
                ' (meta count ' +
                (pg.meta_count != null ? pg.meta_count : '—') +
                ')' +
                (pg.has_next_cursor ? ', more pages' : ', end')
            );
          }
        });
      }
      if (s2.query_preview) {
        lines.push('S2 query preview: ' + String(s2.query_preview).slice(0, 220));
      }
      if (s2.truncated) {
        lines.push('S2 query was truncated to ' + 2800 + ' chars for URL limits.');
      }
      if (s2.requests && s2.requests.length) {
        s2.requests.forEach(function (rq, j) {
          var st = rq.http_status != null ? rq.http_status : '—';
          var bit =
            'S2 request ' +
            (j + 1) +
            ': HTTP ' +
            st +
            ', +' +
            (rq.results_in_batch || 0) +
            (rq.total_reported != null ? ' (total field ' + rq.total_reported + ')' : '');
          lines.push(bit);
          if (rq.url_preview) {
            lines.push('URL: ' + String(rq.url_preview).slice(0, 280));
          }
          if (rq.error_body_preview) {
            lines.push('S2 body: ' + String(rq.error_body_preview).slice(0, 250));
          }
          if (rq.exception) {
            lines.push('S2 exception: ' + String(rq.exception).slice(0, 200));
          }
        });
      }
      if (s2.errors && s2.errors.length) {
        lines.push('S2 errors: ' + s2.errors.join(' | ').slice(0, 400));
      }
      td4.innerHTML = lines.length
        ? lines
            .map(function (line) {
              return '<div class="trace-line">' + esc(line) + '</div>';
            })
            .join('')
        : '—';
      tr.appendChild(td0);
      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    host.appendChild(table);
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

  function renderResult(result, opts) {
    opts = opts || {};
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
    if (!opts.preserveActivityStack) {
      if (stats.activity_log && stats.activity_log.length) {
        renderActivityLog(stats.activity_log);
      } else {
        clearActivityStack();
      }
    }
    renderQueryTrace(stats.query_trace || []);
    resultsEl.classList.remove('rs2-hidden');
  }

  function handleEvent(ev) {
    if (!ev || !ev.event) return;
    if (ev.event === 'progress') {
      startPhaseStopwatch(formatProgress(ev));
    } else if (ev.event === 'heartbeat') {
      var hb =
        (ev.note || 'Still running…') + (ev.source ? ' · ' + String(ev.source).replace(/_/g, ' ') : '');
      if (!phaseTimerId) {
        startPhaseStopwatch(hb);
      } else {
        progressLineBase = hb;
        refreshPhaseProgressLine();
      }
    } else if (ev.event === 'stack' && ev.entry) {
      pausePhaseStopwatch();
      progressLineBase = '';
      var now = Date.now();
      var stepSec = lastStepAt ? (now - lastStepAt) / 1000 : 0;
      var totalSec = runStartedAt ? (now - runStartedAt) / 1000 : 0;
      lastStepAt = now;
      appendActivityEntry(ev.entry, stepSec, totalSec);
      progressEl.textContent = '';
    } else if (ev.event === 'done' && ev.result) {
      pausePhaseStopwatch();
      progressLineBase = '';
      progressEl.textContent = '';
      stopRunTimers();
      var totalRun = runStartedAt ? (Date.now() - runStartedAt) / 1000 : 0;
      runStartedAt = 0;
      setStatus(
        'Retrieval complete. Corpus saved for Enrichment.' +
          (totalRun > 0 ? ' · Total run ' + formatDuration(totalRun) : '') +
          '.',
        'ok'
      );
      renderResult(ev.result, { preserveActivityStack: true });
    } else if (ev.event === 'error') {
      pausePhaseStopwatch();
      progressLineBase = '';
      progressEl.textContent = '';
      stopRunTimers();
      runStartedAt = 0;
      setStatus(ev.message || 'Error', 'err');
    }
  }

  runBtn.addEventListener('click', function () {
    runBtn.disabled = true;
    loadSavedBtn.disabled = true;
    stopRunTimers();
    progressLineBase = '';
    startRunElapsedTimer();
    progressEl.textContent = '';
    clearActivityStack();
    showActivityStack();
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
        pausePhaseStopwatch();
        progressLineBase = '';
        progressEl.textContent = '';
        stopRunTimers();
        runStartedAt = 0;
        var raw = e && e.message ? String(e.message) : 'Failed';
        if (/failed to fetch|networkerror|load failed|network error/i.test(raw)) {
          setStatus(
            'Connection lost during retrieval (browser or proxy closed an idle stream). Retry after deploy — the server now sends periodic keepalives for long Semantic Scholar waits. Technical: ' +
              raw,
            'err'
          );
        } else {
          setStatus(raw, 'err');
        }
      })
      .then(function () {
        if (runStartedAt) {
          pausePhaseStopwatch();
          progressLineBase = '';
          progressEl.textContent = '';
          stopRunTimers();
          runStartedAt = 0;
          if (statusEl.className === '' && /Retrieving/i.test(statusEl.textContent)) {
            setStatus('Stream ended without a final result. Check server logs.', 'err');
          }
        }
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
