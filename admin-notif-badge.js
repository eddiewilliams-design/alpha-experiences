// ============================================================
// ALPHA EXPERIENCES — Admin notification badge auto-installer
//
// Include on any admin page with: <script src="/admin-notif-badge.js"></script>
// The page just needs an element with id="notif-badge" inside the
// admin-nav. This script fetches the notifications feed on load
// (and every 60s after) and updates the badge count + visibility.
// ============================================================
(function(){
  function refresh(){
    var badge = document.getElementById('notif-badge');
    if (!badge) return;
    fetch('/api/admin/notifications-feed', { credentials: 'same-origin' })
      .then(function(r){ return r.status === 200 ? r.json() : null; })
      .then(function(data){
        if (!data || !data.counts) return;
        var n = data.counts.total || 0;
        if (n > 0) { badge.textContent = n; badge.classList.add('show'); }
        else       { badge.classList.remove('show'); }
      })
      .catch(function(){ /* silent — admin page renders fine without */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
  // Refresh every 60s while the page is open
  setInterval(refresh, 60000);
})();
