(function () {
  var raw = document.getElementById('admin-train-json');
  var root = document.getElementById('admin-train-root');
  var statusEl = document.getElementById('admin-train-status');
  if (!raw || !root) return;

  var data = JSON.parse(raw.textContent || '{}');
  var pages = data.pages || [];
  var pageAnchors = data.pageAnchors || [];
  var steps = data.steps || [];

  var token = new URLSearchParams(window.location.search).get('token') || '';
  function apiUrl(path) {
    return path + (token ? '?token=' + encodeURIComponent(token) : '');
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
  }

  function render() {
    var anchorBlocks = pageAnchors
      .map(function (pg) {
        var items = (pg.anchors || [])
          .map(function (a) {
            return (
              '<li><span class="mono">' +
              esc(a.selector) +
              '</span> — ' +
              esc(a.description) +
              '</li>'
            );
          })
          .join('');
        return (
          '<section class="train-page-anchors"><h2>' +
          esc(pg.label) +
          ' <span class="train-slug mono">(' +
          esc(pg.slug) +
          ')</span></h2>' +
          (items
            ? '<ul>' + items + '</ul>'
            : '<p class="train-empty">No documented anchors for this page yet.</p>') +
          '</section>'
        );
      })
      .join('');

    var pageOpts = pages
      .map(function (p) {
        return '<option value="' + esc(p.slug) + '">' + esc(p.label) + '</option>';
      })
      .join('');

    var rows = steps.length
      ? steps
          .map(function (s, i) {
            var slug = s.page_slug;
            var canUp = i > 0 && steps[i - 1].page_slug === slug;
            var canDown = i < steps.length - 1 && steps[i + 1].page_slug === slug;
            return (
              '<tr data-id="' +
              s.id +
              '">' +
              '<td class="mono">' +
              esc(slug) +
              '</td>' +
              '<td class="mono">' +
              esc(s.focus_selector) +
              '</td>' +
              '<td>' +
              esc(s.body_text).slice(0, 200) +
              (s.body_text && s.body_text.length > 200 ? '…' : '') +
              '</td>' +
              '<td>' +
              s.sort_order +
              '</td>' +
              '<td>' +
              (s.enabled ? 'yes' : 'no') +
              '</td>' +
              '<td class="train-move-cell">' +
              '<button type="button" class="train-move-btn train-move-up" data-id="' +
              s.id +
              '" ' +
              (canUp ? '' : 'disabled ') +
              'title="Move earlier on this page">↑</button>' +
              '<button type="button" class="train-move-btn train-move-down" data-id="' +
              s.id +
              '" ' +
              (canDown ? '' : 'disabled ') +
              'title="Move later on this page">↓</button>' +
              '</td>' +
              '<td><button type="button" class="btn-danger train-del" data-id="' +
              s.id +
              '">Delete</button></td>' +
              '</tr>'
            );
          })
          .join('')
      : '';

    root.innerHTML =
      '<div class="train-anchors-wrap">' +
      '<h2 style="font-size:1rem;margin:0 0 0.35rem">Tour focus selectors by page</h2>' +
      '<p class="hint" style="margin-top:0">Use these in the <strong>Focus selector</strong> field. Other stable <span class="mono">#id</span> values on the same screen also work.</p>' +
      anchorBlocks +
      '</div>' +
      '<div class="form-block">' +
      '<h2 style="font-size:1rem;margin:0 0 0.75rem">Add or edit step</h2>' +
      '<label>Page</label><select id="train-page">' +
      pageOpts +
      '</select>' +
      '<label>Focus selector (CSS)</label><input type="text" id="train-selector" placeholder="#tw-portfolio-head" />' +
      '<label>Step text</label><textarea id="train-text" placeholder="Explain this part of the screen."></textarea>' +
      '<label>Order</label><input type="number" id="train-order" value="0" />' +
      '<label><input type="checkbox" id="train-enabled" checked /> Enabled</label>' +
      '<label>Existing row ID (leave empty for new)</label><input type="number" id="train-id" placeholder="optional" />' +
      '<button type="button" class="btn-primary" id="train-save">Save step</button>' +
      '<span id="admin-train-status"></span>' +
      '</div>' +
      '<h2 style="font-size:1rem;margin:1.5rem 0 0.5rem">All steps</h2>' +
      '<table><thead><tr><th>Page</th><th>Selector</th><th>Text</th><th>Order</th><th>On</th><th>Reorder</th><th></th></tr></thead><tbody>' +
      (steps.length ? rows : '<tr><td colspan="7">No steps yet.</td></tr>') +
      '</tbody></table>';

    statusEl = document.getElementById('admin-train-status');

    function postReorder(stepId, direction) {
      fetch(apiUrl('/admin/training-walkthrough/reorder'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId: stepId, direction: direction }),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error(j.error || 'Failed');
            return j;
          });
        })
        .then(function () {
          location.reload();
        })
        .catch(function (e) {
          setStatus(e.message || 'Error', 'err');
        });
    }

    root.querySelectorAll('.train-move-up').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        var id = parseInt(b.getAttribute('data-id'), 10);
        if (!id) return;
        postReorder(id, 'up');
      });
    });
    root.querySelectorAll('.train-move-down').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        var id = parseInt(b.getAttribute('data-id'), 10);
        if (!id) return;
        postReorder(id, 'down');
      });
    });

    root.querySelectorAll('.train-del').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = parseInt(b.getAttribute('data-id'), 10);
        if (!id || !window.confirm('Delete this step?')) return;
        fetch(apiUrl('/admin/training-walkthrough/delete'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        })
          .then(function (r) {
            return r.json().then(function (j) {
              if (!r.ok) throw new Error(j.error || 'Failed');
              return j;
            });
          })
          .then(function () {
            location.reload();
          })
          .catch(function (e) {
            setStatus(e.message || 'Error', 'err');
          });
      });
    });

    document.getElementById('train-save').addEventListener('click', function () {
      var body = {
        pageSlug: document.getElementById('train-page').value,
        focusSelector: document.getElementById('train-selector').value.trim(),
        text: document.getElementById('train-text').value.trim(),
        sortOrder: parseInt(document.getElementById('train-order').value, 10) || 0,
        enabled: document.getElementById('train-enabled').checked,
      };
      var idRaw = document.getElementById('train-id').value.trim();
      if (idRaw) body.id = parseInt(idRaw, 10);
      if (!body.focusSelector || !body.text) {
        setStatus('Selector and text are required.', 'err');
        return;
      }
      fetch(apiUrl('/admin/training-walkthrough/step'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error(j.error || 'Failed');
            return j;
          });
        })
        .then(function () {
          location.reload();
        })
        .catch(function (e) {
          setStatus(e.message || 'Error', 'err');
        });
    });
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  render();
})();
