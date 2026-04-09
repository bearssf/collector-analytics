(function () {
  const titleEl = document.getElementById('rs1-title');
  const kwEl = document.getElementById('rs1-keywords');
  const typeEl = document.getElementById('rs1-type');
  const descEl = document.getElementById('rs1-desc');
  const runBtn = document.getElementById('rs1-run');
  const clearBtn = document.getElementById('rs1-clear');
  const statusEl = document.getElementById('rs1-status');
  const outEl = document.getElementById('rs1-out');

  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = cls || '';
  }

  function parseKeywords(raw) {
    return String(raw || '')
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  runBtn.addEventListener('click', function () {
    const title = (titleEl && titleEl.value) || '';
    const keywords = parseKeywords(kwEl && kwEl.value);
    const projectType = (typeEl && typeEl.value) || 'dissertation';
    const description = (descEl && descEl.value && descEl.value.trim()) || null;

    runBtn.disabled = true;
    setStatus('Calling Bedrock…', '');
    outEl.textContent = '';

    fetch('/api/admin/research-stage1-decompose', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        keywords: keywords,
        projectType: projectType,
        description: description,
      }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (_ref) {
        var data = _ref.data;
        if (!_ref.ok) {
          setStatus(data.error || 'Request failed', 'err');
          return;
        }
        if (data.ok && data.plan) {
          setStatus('Done.', 'ok');
          outEl.textContent = JSON.stringify(data.plan, null, 2);
        } else {
          setStatus(data.error || 'Unexpected response', 'err');
        }
      })
      .catch(function (e) {
        setStatus(e.message || 'Network error', 'err');
      })
      .then(function () {
        runBtn.disabled = false;
      });
  });

  clearBtn.addEventListener('click', function () {
    outEl.textContent = '';
    setStatus('', '');
  });
})();
