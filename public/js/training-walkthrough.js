(function () {
  var cfg = typeof window.__TRAINING_INIT__ !== 'undefined' ? window.__TRAINING_INIT__ : null;
  var alpha =
    typeof window.__TRANS_TRAIN__ === 'number' && !Number.isNaN(window.__TRANS_TRAIN__)
      ? window.__TRANS_TRAIN__
      : 0.4;
  var white = 'rgba(255,255,255,' + Math.min(1, Math.max(0, alpha)) + ')';

  var root = null;
  var dim = null;
  var card = null;
  var arrow = null;
  var textEl = null;
  var btn = null;
  var stepIndex = 0;
  var steps = [];
  var pageSlug = '';
  var lastTarget = null;

  function buildDom() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'tw-root';
    root.setAttribute('role', 'presentation');
    dim = document.createElement('div');
    dim.className = 'tw-dim';
    dim.setAttribute('aria-hidden', 'true');
    card = document.createElement('div');
    card.className = 'tw-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.style.backgroundColor = white;
    arrow = document.createElement('div');
    arrow.className = 'tw-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    textEl = document.createElement('p');
    textEl.className = 'tw-card__text';
    var actions = document.createElement('div');
    actions.className = 'tw-card__actions';
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tw-btn';
    btn.textContent = 'Continue';
    actions.appendChild(btn);
    card.appendChild(arrow);
    card.appendChild(textEl);
    card.appendChild(actions);
    root.appendChild(dim);
    root.appendChild(card);
    document.body.appendChild(root);

    btn.addEventListener('click', onContinue);
    dim.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  }

  function clearTarget() {
    if (lastTarget) {
      lastTarget.classList.remove('tw-target-pulse');
      lastTarget = null;
    }
  }

  function applyArrow(place, tipXFromCardLeft) {
    arrow.className = 'tw-arrow tw-arrow--' + place;
    arrow.style.left = '';
    arrow.style.top = '';
    arrow.style.right = '';
    arrow.style.bottom = '';
    arrow.style.visibility = 'visible';
    if (place === 'bottom') {
      arrow.style.left = tipXFromCardLeft + 'px';
      arrow.style.transform = 'translateX(-50%)';
      arrow.style.borderBottomColor = white;
      arrow.style.borderTopColor = 'transparent';
      arrow.style.borderLeftColor = 'transparent';
      arrow.style.borderRightColor = 'transparent';
    } else if (place === 'top') {
      arrow.style.left = tipXFromCardLeft + 'px';
      arrow.style.transform = 'translateX(-50%)';
      arrow.style.borderTopColor = white;
      arrow.style.borderBottomColor = 'transparent';
      arrow.style.borderLeftColor = 'transparent';
      arrow.style.borderRightColor = 'transparent';
    } else {
      arrow.className = 'tw-arrow';
      arrow.style.visibility = 'hidden';
    }
  }

  function positionCard(targetEl) {
    var pad = 14;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    card.style.visibility = 'hidden';
    card.style.left = pad + 'px';
    card.style.top = pad + 'px';
    var measured = card.getBoundingClientRect();
    var cardW = measured.width || 300;
    var cardH = measured.height || 120;

    if (!targetEl || !(targetEl instanceof Element)) {
      var cx = (vw - cardW) / 2;
      var cy = (vh - cardH) / 2;
      card.style.left = Math.max(pad, cx) + 'px';
      card.style.top = Math.max(pad, cy) + 'px';
      arrow.className = 'tw-arrow';
      arrow.style.visibility = 'hidden';
      card.style.visibility = 'visible';
      return;
    }

    try {
      targetEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    } catch (e) {
      try {
        targetEl.scrollIntoView(true);
      } catch (e2) {
        /* ignore */
      }
    }

    var tr = targetEl.getBoundingClientRect();
    var tcx = tr.left + tr.width / 2;
    var spaceBelow = vh - tr.bottom - pad;
    var spaceAbove = tr.top - pad;
    var place = spaceBelow >= cardH + 24 || spaceBelow >= spaceAbove ? 'bottom' : 'top';
    var top;
    if (place === 'bottom') {
      top = tr.bottom + pad;
    } else {
      top = tr.top - cardH - pad;
    }
    var left = tcx - cardW / 2;
    left = Math.max(pad, Math.min(left, vw - cardW - pad));
    top = Math.max(pad, Math.min(top, vh - cardH - pad));

    if (place === 'bottom' && top + cardH > vh - pad) {
      place = 'top';
      top = tr.top - cardH - pad;
      top = Math.max(pad, top);
    } else if (place === 'top' && top < pad) {
      place = 'bottom';
      top = tr.bottom + pad;
      top = Math.min(top, vh - cardH - pad);
    }

    card.style.left = left + 'px';
    card.style.top = top + 'px';

    var tipX = tcx - left;
    tipX = Math.max(24, Math.min(cardW - 24, tipX));
    if (place === 'bottom') {
      applyArrow('bottom', tipX);
    } else {
      applyArrow('top', tipX);
    }

    card.style.visibility = 'visible';
  }

  function onResize() {
    if (!root || !root.classList.contains('tw-root--active')) return;
    showStep(stepIndex);
  }

  function showStep(i) {
    if (!steps.length || i < 0 || i >= steps.length) return;
    var s = steps[i];
    textEl.textContent = s.text || '';
    btn.textContent = i >= steps.length - 1 ? 'Done' : 'Continue';

    clearTarget();
    var el = null;
    try {
      el = document.querySelector(s.focusSelector);
    } catch (e) {
      el = null;
    }
    if (el) {
      el.classList.add('tw-target-pulse');
      lastTarget = el;
    }

    requestAnimationFrame(function () {
      positionCard(el);
    });
  }

  function openTour() {
    buildDom();
    root.classList.add('tw-root--active');
    stepIndex = 0;
    showStep(0);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
  }

  function closeTour() {
    if (!root) return;
    root.classList.remove('tw-root--active');
    clearTarget();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || 'Request failed');
        return data;
      });
    });
  }

  function onContinue() {
    if (stepIndex >= steps.length - 1) {
      postJson('/api/me/training/complete', { pageSlug: pageSlug })
        .then(function () {
          closeTour();
        })
        .catch(function () {
          closeTour();
        });
      return;
    }
    stepIndex += 1;
    showStep(stepIndex);
  }

  function startTour(opts) {
    opts = opts || {};
    if (!cfg || !cfg.steps || !cfg.steps.length) return;
    steps = cfg.steps.slice().sort(function (a, b) {
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
    pageSlug = cfg.pageSlug || '';
    if (opts.force) {
      postJson('/api/me/training/reset', { pageSlug: pageSlug })
        .then(function () {
          openTour();
        })
        .catch(function () {
          openTour();
        });
    } else {
      openTour();
    }
  }

  window.__trainingWalkthrough = { start: startTour };

  if (cfg && cfg.steps && cfg.steps.length && cfg.autoStart && !cfg.completed) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        startTour({ force: false });
      });
    } else {
      startTour({ force: false });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var replayBtn = document.getElementById('app-sidebar-training-replay');
    if (!replayBtn) return;
    replayBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var slug = replayBtn.getAttribute('data-page-slug');
      if (!slug || !cfg || !cfg.steps || !cfg.steps.length) return;
      cfg.pageSlug = slug;
      startTour({ force: true });
    });
  });
})();
