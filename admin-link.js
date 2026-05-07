// ============================================================
// ALPHA EXPERIENCES — Admin shortcut pill
//
// Include on any STUDENT-side page with:
//   <script src="/admin-link.js"></script>
//
// On load, this script asks /auth/me whether the visitor is an
// admin. If so, it injects a small "⚙ Admin" pill into the
// page's .header-right slot (or replaces an existing
// <a id="admin-link"> placeholder if you'd rather control
// placement explicitly).
//
// Non-admins see nothing — the pill never appears, the script
// silently exits. No effect on the page otherwise.
// ============================================================
(function(){
  function paint(user){
    if (!user || !user.isAdmin) return;

    // Prefer an explicit placeholder if the page provides one
    var existing = document.getElementById('admin-link');
    if (existing) {
      existing.classList.add('show');
      if (!existing.getAttribute('href')) existing.setAttribute('href', '/admin');
      if (!existing.textContent) existing.textContent = '⚙ Admin';
      return;
    }

    // Student-side pages use .user-wrap (the user-chip container);
    // admin pages use .header-right. Support both: prefer inserting
    // right BEFORE the user-wrap, falling back to header-right.
    var userWrap = document.querySelector('.user-wrap');
    var slot     = userWrap ? userWrap.parentNode : document.querySelector('.header-right');
    if (!slot) return;

    var a = document.createElement('a');
    a.id   = 'admin-link';
    a.href = '/admin';
    a.textContent = '⚙ Admin';
    a.title = 'Open admin dashboard';
    a.style.cssText = [
      'background:#E59500',
      'color:#3a2000',
      'font-size:11px',
      'font-weight:800',
      'padding:5px 12px',
      'border-radius:999px',
      'letter-spacing:0.04em',
      'text-transform:uppercase',
      'text-decoration:none',
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
      'margin-right:6px'
    ].join(';');
    a.addEventListener('mouseenter', function(){ a.style.background = '#c98000'; });
    a.addEventListener('mouseleave', function(){ a.style.background = '#E59500'; });

    if (userWrap) slot.insertBefore(a, userWrap);
    else          slot.insertBefore(a, slot.firstChild);
  }

  function check(){
    fetch('/auth/me', { credentials: 'same-origin' })
      .then(function(r){ return r.status === 200 ? r.json() : null; })
      .then(paint)
      .catch(function(){ /* silent */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
