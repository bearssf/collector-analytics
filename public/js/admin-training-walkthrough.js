(function () {
  var raw = document.getElementById('admin-train-json');
  var root = document.getElementById('admin-train-root');
  var statusEl = document.getElementById('admin-train-status');
  if (!raw || !root) return;

  var data = JSON.parse(raw.textContent || '{}');
  var pages = data.pages || [];
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
    var pageOpts = pages
      .map(function (p) {
        return '<option value="' + esc(p.slug) + '">' + esc(p.label) + '</option>';
      })
      .join('');

    var rows = steps.length
      ? steps
          .map(function (s) {
        return (
          '<tr data-id="' +
          s.id +
          '">' +
          '<td class="mono">' +
          esc(s.page_slug) +
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
          '<td><button type="button" class="btn-danger train-del" data-id="' +
          s.id +
          '">Delete</button></td>' +
          '</tr>'
        );
      })
          .join('')
      : '';

    root.innerHTML =
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
      '<table><thead><tr><th>Page</th><th>Selector</th><th>Text</th><th>Order</th><th>On</th><th></th></tr></thead><tbody>' +
      (steps.length ? rows : '<tr><td colspan="6">No steps yet.</td></tr>') +
      '</tbody></table>';

    statusEl = document.getElementById('admin-train-status');

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
