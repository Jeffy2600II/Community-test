// public/js/main.js (updated: header/mobile toggle, separate dropdown overlay, dropdown z-index fixes)
// See conversation: ensure dropdown appears above mobile sidebar and overlay, overlay touch closes dropdown immediately,
// and opening dropdown does NOT auto-close mobile sidebar.

 /* -------------------- Utilities -------------------- */
async function loadPartial(id, file) {
  try {
    const resp = await fetch(file);
    const html = await resp.text();
    document.getElementById(id).innerHTML = html;
  } catch (e) {
    console.error('loadPartial error', e && e.message);
  }
}

function elFrom(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstChild;
}

/* -------------------- Globals -------------------- */
let globalAccounts = [];
let globalActive = null;
let dropdownEl = null;
let dropdownVisible = false;
let dropdownOverlayEl = null;
let dropdownEscapeListener = null;
let dropdownTouchCloseHandler = null;

/* -------------------- Header interactions (mobile + sidebar) -------------------- */
function setupHeaderInteractions() {
  const toggle = document.getElementById('mobileMenuToggle');
  const headerBottom = document.getElementById('headerBottom');
  const mobileSidebarClose = document.getElementById('mobileSidebarClose');
  const mobileOverlay = document.getElementById('mobileSidebarOverlay');
  const sidebar = document.getElementById('mobileSidebar');
  if (!toggle) return;

  // On small screens: toggle opens right-side sidebar.
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const w = window.innerWidth;
    if (w > 800) {
      if (!headerBottom) return;
      const isOpen = headerBottom.classList.toggle('open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      // keep existing dropdown state unchanged
    } else {
      if (!sidebar) return;
      const isOpen = sidebar.classList.toggle('open');
      sidebar.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

      if (isOpen) {
        // show sidebar overlay (separate from dropdown overlay)
        if (mobileOverlay) {
          mobileOverlay.classList.remove('hidden');
          mobileOverlay.classList.add('show');
          mobileOverlay.setAttribute('aria-hidden', 'false');
        }
        document.body.style.overflow = 'hidden';
        // note: do NOT hide dropdown when opening sidebar (per request)
      } else {
        if (mobileOverlay) {
          mobileOverlay.classList.add('hidden');
          mobileOverlay.classList.remove('show');
          mobileOverlay.setAttribute('aria-hidden', 'true');
        }
        document.body.style.overflow = '';
      }
    }
  });

  // close sidebar via close button
  if (mobileSidebarClose) {
    mobileSidebarClose.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMobileSidebar();
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  }

  // overlay click closes sidebar
  if (mobileOverlay) {
    mobileOverlay.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMobileSidebar();
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }, { passive: false });
    // also touchstart for immediate response
    mobileOverlay.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMobileSidebar();
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }, { passive: false });
  }

  // close headerBottom / sidebar when clicking outside
  document.addEventListener('click', (ev) => {
    if (headerBottom && headerBottom.classList.contains('open') && window.innerWidth > 800) {
      const path = ev.composedPath ? ev.composedPath() : (ev.path || []);
      if (!path || path.length === 0) return;
      if (!path.includes(headerBottom) && !path.includes(toggle)) {
        headerBottom.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    }
    // if sidebar open and click outside -> close (overlay handles most cases)
    const sb = document.getElementById('mobileSidebar');
    if (sb && sb.classList.contains('open') && window.innerWidth <= 800) {
      const path = ev.composedPath ? ev.composedPath() : (ev.path || []);
      if (!path || path.length === 0) return;
      if (!path.includes(sb) && !path.includes(toggle) && !path.includes(document.getElementById('mobileSidebarOverlay'))) {
        closeMobileSidebar();
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      }
    }
  }, true);

  // ensure headerBottom / toggle / sidebar state on resize
  function headerResizeHandler() {
    const w = window.innerWidth;
    if (w > 800) {
      if (headerBottom) headerBottom.classList.add('open');
      if (toggle) {
        toggle.setAttribute('aria-expanded', 'true');
        toggle.style.display = 'none';
      }
      closeMobileSidebar();
    } else {
      if (headerBottom) headerBottom.classList.remove('open');
      if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.style.display = '';
      }
      closeMobileSidebar();
    }
  }
  window.addEventListener('resize', headerResizeHandler);
  headerResizeHandler();
}

/* -------------------- Mobile sidebar helpers -------------------- */
function closeMobileSidebar() {
  const sb = document.getElementById('mobileSidebar');
  const ov = document.getElementById('mobileSidebarOverlay');
  const toggle = document.getElementById('mobileMenuToggle');
  if (!sb || !ov) return;
  sb.classList.remove('open');
  sb.setAttribute('aria-hidden', 'true');
  ov.classList.add('hidden');
  ov.classList.remove('show');
  ov.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

/* -------------------- Fetch helpers -------------------- */
async function fetchAccounts() {
  try {
    const r = await fetch('/api/accounts');
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.success) return data;
    return null;
  } catch (err) {
    console.warn('fetchAccounts error', err && err.message);
    return null;
  }
}

async function fetchNotifications() {
  try {
    const r = await fetch('/api/notifications');
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.success) return data;
    return null;
  } catch (err) {
    console.warn('fetchNotifications error', err && err.message);
    return null;
  }
}

/* -------------------- Dropdown (separate overlay) -------------------- */
function ensureDropdown() {
  if (dropdownEl && document.body.contains(dropdownEl)) return dropdownEl;
  dropdownEl = document.createElement('div');
  dropdownEl.id = 'accountDropdown';
  dropdownEl.className = 'dropdown-panel';
  dropdownEl.style.display = 'none';
  dropdownEl.style.position = 'absolute';
  // ensure dropdown is top-most relative to mobile sidebar
  dropdownEl.style.zIndex = '3000';
  dropdownEl.style.boxShadow = '0 8px 40px rgba(15,23,42,0.18)';
  dropdownEl.style.background = '#fff';
  dropdownEl.style.borderRadius = '10px';
  dropdownEl.style.overflow = 'hidden';
  dropdownEl.style.pointerEvents = 'auto';
  document.body.appendChild(dropdownEl);
  return dropdownEl;
}

function createDropdownOverlay() {
  if (dropdownOverlayEl && document.body.contains(dropdownOverlayEl)) return dropdownOverlayEl;
  dropdownOverlayEl = document.createElement('div');
  dropdownOverlayEl.id = 'dropdownOverlay';
  // Slightly transparent / capture touches; visually subtle because dropdown itself is the visible element.
  dropdownOverlayEl.style.position = 'fixed';
  dropdownOverlayEl.style.inset = '0';
  dropdownOverlayEl.style.background = 'transparent';
  dropdownOverlayEl.style.zIndex = '2950'; // below dropdownEl (3000) but above sidebar (2000)
  dropdownOverlayEl.style.pointerEvents = 'auto';

  // Click closes dropdown immediately; do not affect mobile sidebar
  const closeNow = function (ev) {
    try {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (ev && ev.stopPropagation) ev.stopPropagation();
    } catch (e) {}
    hideDropdown();
  };

  dropdownOverlayEl.addEventListener('click', closeNow, { passive: false });
  // immediate response on touchstart for mobile (close on touch)
  dropdownTouchCloseHandler = function (ev) {
    try {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (ev && ev.stopPropagation) ev.stopPropagation();
    } catch (e) {}
    hideDropdown();
  };
  dropdownOverlayEl.addEventListener('touchstart', dropdownTouchCloseHandler, { passive: false });

  return dropdownOverlayEl;
}

function showDropdownOverlay() {
  const ov = createDropdownOverlay();
  if (!document.body.contains(ov)) document.body.appendChild(ov);
  if (dropdownEl && document.body.contains(dropdownEl)) document.body.appendChild(dropdownEl);
  // set escape key listener for dropdown only
  dropdownEscapeListener = function (ev) {
    if (ev.key === 'Escape' && dropdownVisible) {
      ev.preventDefault();
      hideDropdown();
    }
  };
  document.addEventListener('keydown', dropdownEscapeListener, true);
}

function hideDropdownOverlay() {
  if (dropdownOverlayEl && document.body.contains(dropdownOverlayEl)) {
    // remove listeners added
    try {
      dropdownOverlayEl.removeEventListener('touchstart', dropdownTouchCloseHandler);
      dropdownOverlayEl.removeEventListener('click', hideDropdown);
    } catch (e) {}
    dropdownOverlayEl.remove();
  }
  if (dropdownEscapeListener) {
    document.removeEventListener('keydown', dropdownEscapeListener, true);
    dropdownEscapeListener = null;
  }
}

/* show/hide dropdown */
function showDropdown() {
  ensureDropdown();
  showDropdownOverlay();
  dropdownEl.style.display = 'block';
  dropdownVisible = true;
}
function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownVisible = false;
  hideDropdownOverlay();
}

/* -------------------- Notification helpers -------------------- */
function isNotificationFromActive(n, activeUsername) {
  if (!activeUsername) return true;
  const a = String(activeUsername);
  const props = ['username','author','actor','from','postAuthor','createdBy','user'];
  for (let p of props) {
    if (n[p] && String(n[p]) === a) return false;
  }
  if (n.post && n.post.username && String(n.post.username) === a) return false;
  if (n.item && n.item.owner && String(n.item.owner) === a) return false;
  return true;
}
function computeNotificationUrl(n) {
  if (!n || !n.meta) return null;
  const m = n.meta;
  if (m.url) return m.url;
  if (m.postId) return `/post/${encodeURIComponent(m.postId)}`;
  if (m.commentId && m.postId) return `/post/${encodeURIComponent(m.postId)}#comment-${encodeURIComponent(m.commentId)}`;
  if (m.actorUsername) return `/user/${encodeURIComponent(m.actorUsername)}`;
  if (m.username) return `/user/${encodeURIComponent(m.username)}`;
  if (m.item && m.item.type === 'post' && m.item.id) return `/post/${encodeURIComponent(m.item.id)}`;
  return null;
}

/* -------------------- Positioning -------------------- */
async function positionDropdownRelativeTo(anchorEl) {
  const dd = ensureDropdown();
  const winW = window.innerWidth;
  // if mobile sidebar is open and viewport narrow, position dropdown to overlay on top of sidebar
  const mobileSidebar = document.getElementById('mobileSidebar');
  const sidebarOpen = mobileSidebar && mobileSidebar.classList.contains('open');

  if (winW <= 800) {
    // place dropdown under header (default top) and align its right edge near viewport right so it overlays the sidebar
    const top = (document.querySelector('.site-header')?.getBoundingClientRect().bottom || 68) + window.scrollY + 8;
    dd.style.top = top + 'px';
    // if sidebar open, align dropdown's right to 12px so it appears over sidebar
    if (sidebarOpen) {
      dd.style.right = '12px';
      dd.style.left = 'auto';
      dd.style.width = Math.min(360, winW - 24) + 'px';
    } else {
      // no sidebar: full-width-friendly layout but keep some margin
      dd.style.left = '12px';
      dd.style.right = '12px';
      dd.style.width = 'auto';
    }
  } else {
    const rect = anchorEl.getBoundingClientRect();
    const ddWidth = Math.min(420, Math.max(320, rect.width * 2));
    dd.style.width = ddWidth + 'px';
    const right = window.innerWidth - rect.right - 12;
    dd.style.right = Math.max(12, right) + 'px';
    dd.style.left = '';
    dd.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  }
}

/* -------------------- Nav rendering -------------------- */
async function renderNav() {
  const nav = document.getElementById('navBar');
  if (!nav) return;
  nav.innerHTML = '';

  // Left-side (brief links)
  const left = elFrom(`<div class="nav-left" style="display:flex;align-items:center;gap:12px;">
    <a href="/" class="small-link">หน้าแรก</a>
    <a href="/post/create" class="small-link">สร้างโพสต์</a>
  </div>`);
  nav.appendChild(left);

  const accountArea = document.createElement('div');
  accountArea.className = 'header-actions';
  accountArea.style.display = 'flex';
  accountArea.style.alignItems = 'center';
  accountArea.style.gap = '10px';

  const accData = await fetchAccounts();
  const notifData = await fetchNotifications();

  // Notification bell
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.setAttribute('role','button');
  bell.setAttribute('aria-label','Notifications');
  bell.style.cursor = 'pointer';
  bell.style.position = 'relative';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#97a0b3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path></svg>`;

  let badgeCount = 0;
  if (notifData && notifData.notifications) {
    let activeName = accData && accData.active ? accData.active : null;
    const filtered = (notifData.notifications || []).filter(n => isNotificationFromActive(n, activeName));
    if (filtered.length > 0) {
      const hasReadFlag = Object.prototype.hasOwnProperty.call(filtered[0], 'read');
      badgeCount = hasReadFlag ? filtered.filter(n => !n.read).length : (notifData.unread || 0);
    } else badgeCount = 0;
  } else if (notifData && notifData.unread) badgeCount = notifData.unread;

  if (badgeCount && badgeCount > 0) {
    const badge = document.createElement('div');
    badge.className = 'notify-badge';
    badge.innerText = badgeCount > 99 ? '99+' : badgeCount;
    badge.style.position = 'absolute';
    badge.style.top = '-6px';
    badge.style.right = '-6px';
    badge.style.background = '#ff4d6d';
    badge.style.color = '#fff';
    badge.style.fontSize = '11px';
    badge.style.padding = '2px 6px';
    badge.style.borderRadius = '999px';
    badge.style.fontWeight = '700';
    bell.appendChild(badge);
  }
  accountArea.appendChild(bell);

  // If user accounts exist, render avatar + account dropdown; otherwise login/register
  if (accData && accData.accounts && accData.accounts.length > 0) {
    globalAccounts = accData.accounts;
    globalActive = accData.active;
    const activeAcc = globalAccounts.find(a => a.username === globalActive) || globalAccounts[0];
    const avatarUrl = activeAcc.profilePic || '/img/default_profile.png';

    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'avatar-btn';
    avatarBtn.type = 'button';
    avatarBtn.style.display = 'inline-flex';
    avatarBtn.style.alignItems = 'center';
    avatarBtn.style.gap = '8px';
    avatarBtn.style.border = 'none';
    avatarBtn.style.background = 'transparent';
    avatarBtn.style.padding = '6px';
    avatarBtn.style.cursor = 'pointer';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="${activeAcc.username}" style="width:32px;height:32px;border-radius:8px;object-fit:cover"> <span style="color:#1f2a37;font-weight:700">${activeAcc.displayName || activeAcc.username}</span>`;
    accountArea.appendChild(avatarBtn);

    const dd = ensureDropdown();
    dd.innerHTML = '';

    avatarBtn.onclick = async (ev) => {
      ev.stopPropagation();
      // Toggle dropdown open/close
      if (dropdownVisible) { hideDropdown(); return; }
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.innerHTML = `<img src="${avatarUrl}" class="avatar-img" style="width:48px;height:48px;border-radius:8px;object-fit:cover"><div style="flex:1"><div style="font-weight:700">${activeAcc.displayName || activeAcc.username}</div><div class="small" style="color:var(--muted)">${activeAcc.username}</div></div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.className = 'dropdown-list';
      list.style.padding = '8px';
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '8px';
      dd.appendChild(list);

      for (let acc of globalAccounts) {
        if (acc.username === globalActive) continue;
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.innerHTML = `<img src="${acc.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:36px;height:36px;border-radius:6px;object-fit:cover"><div style="flex:1"><div style="font-weight:700">${acc.displayName || acc.username}</div><div class="small" style="color:var(--muted)">${acc.username}</div></div>`;
        item.onclick = async () => {
          const confirmSwitch = confirm(`สลับไปใช้บัญชี ${acc.username} ?`);
          if (!confirmSwitch) return;
          try {
            const r = await fetch('/api/accounts/switch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: acc.username })
            });
            const d = await r.json();
            if (d.success) {
              await renderNav();
              hideDropdown();
              window.dispatchEvent(new Event('accountsChanged'));
            } else alert(d.msg || 'ไม่สามารถสลับบัญชีได้');
          } catch {
            alert('เกิดข้อผิดพลาดขณะสลับบัญชี');
          }
        };
        list.appendChild(item);
      }

      const footer = document.createElement('div');
      footer.style.padding = '8px';
      footer.style.borderTop = '1px solid rgba(15,23,42,0.04)';
      footer.style.display = 'flex';
      footer.style.justifyContent = 'space-between';
      footer.innerHTML = `<div><a href="/accounts">จัดการบัญชี</a></div><div><a href="/login?add=1" class="small">เพิ่มบัญชี</a></div>`;
      dd.appendChild(footer);

      await positionDropdownRelativeTo(avatarBtn);
      showDropdown();
    };

    // Notification bell handling (similar to previous, opens dropdown contents)
    bell.onclick = async (ev) => {
      ev.stopPropagation();
      const nd = await fetchNotifications();
      const dd = ensureDropdown();
      dd.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.style.padding = '12px';
      header.style.borderBottom = '1px solid rgba(15,23,42,0.04)';
      let visibleNotifs = [];
      if (nd && nd.notifications) visibleNotifs = (nd.notifications || []).filter(n => isNotificationFromActive(n, globalActive));
      const unreadCount = visibleNotifs && visibleNotifs.length > 0 && Object.prototype.hasOwnProperty.call(visibleNotifs[0], 'read')
        ? visibleNotifs.filter(n => !n.read).length
        : (nd ? (nd.unread || 0) : 0);
      header.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;"><div><strong>การแจ้งเตือน</strong><div class="small">${unreadCount} รายการยังไม่อ่าน</div></div></div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.style.maxHeight = '360px';
      list.style.overflow = 'auto';
      list.style.padding = '8px';
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '6px';

      if (!visibleNotifs || visibleNotifs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dropdown-item';
        empty.style.padding = '12px';
        empty.innerHTML = `<div class="small">ยังไม่มีการแจ้งเตือน</div>`;
        list.appendChild(empty);
      } else {
        for (let n of visibleNotifs.slice(0, 60)) {
          const it = document.createElement('div');
          it.className = 'dropdown-item';
          it.style.borderBottom = '1px solid rgba(15,23,42,0.03)';
          it.style.padding = '10px';
          it.style.display = 'flex';
          it.style.flexDirection = 'column';
          it.style.gap = '6px';
          it.style.cursor = 'pointer';
          const title = document.createElement('div');
          title.style.display = 'flex';
          title.style.justifyContent = 'space-between';
          title.innerHTML = `<div style="font-weight:700">${n.type || 'การแจ้งเตือน'}</div><div class="small">${new Date(n.createdAt).toLocaleString()}</div>`;
          const msg = document.createElement('div');
          msg.className = 'small';
          msg.textContent = n.message || '';
          it.appendChild(title);
          it.appendChild(msg);
          if (!n.read) it.style.background = '#fffef6';
          it.onclick = async () => {
            const dest = computeNotificationUrl(n);
            try {
              await fetch('/api/notifications/mark-read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [n.id] })
              });
            } catch (err) { console.warn('mark-read failed', err && err.message); }
            hideDropdown();
            setTimeout(() => window.dispatchEvent(new Event('accountsChanged')), 120);
            if (dest) location.assign(dest);
          };
          list.appendChild(it);
        }
        const footer = document.createElement('div');
        footer.style.padding = '8px';
        footer.style.textAlign = 'right';
        footer.innerHTML = `<a href="#" id="markAllRead" class="small">ทำเครื่องหมายว่าอ่านทั้งหมด</a>`;
        list.appendChild(footer);
      }

      dd.appendChild(list);
      await positionDropdownRelativeTo(bell);
      showDropdown();

      const mar = dd.querySelector('#markAllRead');
      if (mar) {
        mar.onclick = async (ev) => {
          ev.preventDefault();
          try {
            await fetch('/api/notifications/mark-read', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            });
          } catch (err) { console.warn('mark all read failed', err && err.message); }
          hideDropdown();
          await renderNav();
        };
      }
    };

  } else {
    accountArea.appendChild(elFrom('<a href="/login" class="btn btn-ghost">เข้าสู่ระบบ</a>'));
    accountArea.appendChild(elFrom('<a href="/register" class="btn">สมัครสมาชิก</a>'));
  }

  nav.appendChild(accountArea);

  // mirror nav into mobile sidebar for small screens (vertical layout)
  try {
    const mobileNav = document.getElementById('mobileSidebarNav');
    if (mobileNav) {
      mobileNav.innerHTML = '';
      const leftClone = left.cloneNode(true);
      leftClone.style.display = 'flex';
      leftClone.style.flexDirection = 'column';
      leftClone.querySelectorAll('a').forEach(a => { a.style.display = 'block'; a.style.padding = '10px 12px'; a.style.borderRadius = '10px'; });

      const acctClone = accountArea.cloneNode(true);
      acctClone.querySelectorAll('button, a, .avatar-img').forEach(el => {
        el.removeAttribute('onclick');
        el.style.display = 'block';
        if (el.tagName === 'IMG') el.style.width = '48px';
      });

      mobileNav.appendChild(leftClone);
      mobileNav.appendChild(acctClone);

      const extras = document.createElement('div');
      extras.style.paddingTop = '8px';
      extras.innerHTML = `<a href="/accounts" class="small-link" style="display:block;padding:10px 12px;border-radius:10px;">จัดการบัญชี</a><a href="/notifications" class="small-link" style="display:block;padding:10px 12px;border-radius:10px;margin-top:6px;">การแจ้งเตือน</a>`;
      mobileNav.appendChild(extras);
    }
  } catch (e) {
    console.warn('mirror to mobileSidebarNav failed', e && e.message);
  }

  // click outside to close dropdown
  document.addEventListener('click', function () {
    if (dropdownVisible) hideDropdown();
  }, true);
}

/* -------------------- Events -------------------- */
function setupGlobalRefreshOnMessage() {
  window.addEventListener('accountsChanged', async () => {
    await renderNav();
  });
}

/* -------------------- Init -------------------- */
window.onload = async function() {
  // load header/footer partials if present
  await loadPartial('headerSlot', '/partial/header.html').catch(()=>{});
  await loadPartial('footerSlot', '/partial/footer.html').catch(()=>{});
  // header interactions must be setup after partial is injected
  setupHeaderInteractions();
  setupGlobalRefreshOnMessage();
  await renderNav();

  // attach close handler to mobile sidebar close control (in case renderNav ran earlier)
  const mobileSidebarClose = document.getElementById('mobileSidebarClose');
  if (mobileSidebarClose) mobileSidebarClose.addEventListener('click', () => { closeMobileSidebar(); });
};