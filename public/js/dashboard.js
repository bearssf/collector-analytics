(function () {
  document.querySelectorAll('.app-dashboard-delete').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = btn.getAttribute('data-project-id');
      var raw = btn.getAttribute('data-project-name') || '';
      var name = raw ? decodeURIComponent(raw) : 'this project';
      var msg =
        'Delete “' +
        name +
        '”?\n\nThis permanently removes the project and all of its drafts, sources, and suggestions. This cannot be undone.';
      if (!window.confirm(msg)) return;
      btn.disabled = true;
      fetch('/api/projects/' + encodeURIComponent(id), {
        method: 'DELETE',
        credentials: 'same-origin',
      })
        .then(function (res) {
          if (res.status === 204) {
            window.location.reload();
            return;
          }
          return res.json().then(function (data) {
            throw new Error((data && data.error) || 'Could not delete project.');
          });
        })
        .catch(function (err) {
          window.alert(err.message || 'Could not delete project.');
          btn.disabled = false;
        });
    });
  });
})();
