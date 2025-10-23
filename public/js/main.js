// public/js/main.js (updated: header mobile toggle now opens a right-side mobile sidebar with overlay)
//
// - Mobile toggle opens a right-side sidebar on small screens and moves #navBar into it.
// - Sidebar overlay closes sidebar on click; Escape also closes it.
// - When sidebar is open we close other dropdowns to avoid stacking.
// - On desktop the toggle behaves as before (show/hide headerBottom).

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
let overlayEl = null;
let escapeKeyListener = null;

/* -------------------- Sidebar helpers -------------------- */
function ensureSidebarElements() {
  const sidebar = document.getElementById('mobileSidebar');
  const overlay = document.getElementById('sidebarOverlay');
  return { sidebar, overlay };
}
function openSidebar() {
  const { sidebar, overlay } = ensureSidebarElements();
  if (!sidebar || !overlay) return;
  // close other dropdowns
  hideDropdown();
  // move navBar into sidebar if present
  const navBar = document.getElementById('navBar');
  const mobileNavSlot = document.getElementById('mobileSidebarNav');
  if (navBar && mobileNavSlot && !mobileNavSlot.contains(navBar)) {
    mobileNavSlot.appendChild(navBar);
  }
  sidebar.classList.add('open');
  sidebar.setAttribute('aria-hidden', 'false');
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  // focus management
  try { sidebar.querySelector('button, a, [role="button"], input')?.focus(); } catch(e){}
  // attach escape listener
  addSidebarEscapeHandler();
}
function closeSidebar() {
  const { sidebar, overlay } = ensureSidebarElements();
  if (!sidebar || !overlay) return;
  // move navBar back into headerBottom (so desktop layout remains stable)
  const navBar = document.getElementById('navBar');
  const headerBottom = document.getElementById('headerBottom');
  if (navBar && headerBottom && !headerBottom.contains(navBar)) {
    headerBottom.appendChild(navBar);
  }
  sidebar.classList.remove('open');
  sidebar.setAttribute('aria-hidden', 'true');
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  removeSidebarEscapeHandler();
}
function addSidebarEscapeHandler() {
  if (escapeKeyListener) return;
  escapeKeyListener = function (ev) {
    if (ev.key === 'Escape') {
      if (document.getElementById('mobileSidebar')?.classList.contains('open')) {
        ev.preventDefault();
        closeSidebar();
      }
    }
  };
  document.addEventListener('keydown', escapeKeyListener, true);
}
function removeSidebarEscapeHandler() {
  if (!escapeKeyListener) return;
  document.removeEventListener('keydown', escapeKeyListener, true);
  escapeKeyListener = null;
}

/* -------------------- Header interactions (mobile) -------------------- */
function setupHeaderInteractions() {
  const toggle = document.getElementById('mobileMenuToggle');
  const headerBottom = document.getElementById('headerBottom');
  const sidebar = document.getElementById('mobileSidebar');
  const sidebarClose = document.getElementById('mobileSidebarClose');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  if (!toggle || !headerBottom) return;

  // On small screens mobileMenuToggle will open the right-side sidebar.
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const w = window.innerWidth;
    if (w <= 800) {
      const isOpen = sidebar && sidebar.classList.contains('open');
      if (isOpen) closeSidebar(); else openSidebar();
      toggle.setAttribute('aria-expanded', (!isOpen) ? 'true' : 'false');
      // when opening the mobile sidebar, close other dropdowns/overlays to avoid stacking
      if (!isOpen) hideDropdown();
    } else {
      // Desktop/tablet behavior: toggle headerBottom open/close
      const isOpen = headerBottom.classList.toggle('open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (isOpen) hideDropdown();
    }
  });

  // sidebar close btn
  if (sidebarClose) {
    sidebarClose.addEventListener('click', (ev) => { ev.stopPropagation(); closeSidebar(); toggle.setAttribute('aria-expanded','false'); });
  }
  // overlay click closes sidebar
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); closeSidebar(); toggle.setAttribute('aria-expanded','false'); }, { passive: false });
  }

  // close headerBottom if clicked outside (mobile toggle)
  document.addEventListener('click', (ev) => {
    // if headerBottom is open on mobile, clicking outside should close it
    if (headerBottom.classList.contains('open') && window.innerWidth <= 800) {
      const path = ev.composedPath ? ev.composedPath() : (ev.path || []);
      if (!path || path.length === 0) return;
      if (!path.includes(headerBottom) && !path.includes(toggle) && !document.getElementById('mobileSidebar')?.contains(ev.target)) {
        headerBottom.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    }
  }, true);

  // ensure headerBottom and sidebar state on resize
  function headerResizeHandler() {
    const w = window.innerWidth;
    if (w > 800) {
      // on desktop/tablet show headerBottom and hide sidebar UI
      headerBottom.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.style.display = 'none';
      // ensure sidebar is closed and navBar is back
      closeSidebar();
    } else {
      // on small screens hide headerBottom by default, show toggle
      headerBottom.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.style.display = '';
    }
  }
  window.addEventListener('resize', headerResizeHandler);
  // initial call
  headerResizeHandler();
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

/* -------------------- Dropdown + Overlay (unchanged) -------------------- */
function ensureDropdown() {
  if (dropdownEl && document.body.contains(dropdownEl)) return dropdownEl;
  dropdownEl = document.createElement('div');
  dropdownEl.id = 'accountDropdown';
  dropdownEl.className = 'dropdown-panel';
  dropdownEl.style.display = 'none';
  dropdownEl.style.position = 'absolute';
  dropdownEl.style.zIndex = '1400';
  dropdownEl.style.boxShadow = '0 8px 24px rgba(15,23,42,0.08)';
  dropdownEl.style.background = '#fff';
  dropdownEl.style.borderRadius = '10px';
  dropdownEl.style.overflow = 'hidden';
  document.body.appendChild(dropdownEl);
  return dropdownEl;
}

function createOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.id = 'dropdownOverlay';
  overlayEl.style.position = 'fixed';
  overlayEl.style.inset = '0';
  overlayEl.style.background = 'transparent';
  overlayEl.style.zIndex = '1300';
  overlayEl.style.pointerEvents = 'auto';
  overlayEl.addEventListener('click', function (ev) {
    ev.preventDefault(); ev.stopPropagation(); hideDropdown();
  }, { passive: false });
  return overlayEl;
}

function showOverlay() {
  const ov = createOverlay();
  if (!document.body.contains(ov)) document.body.appendChild(ov);
  if (dropdownEl && document.body.contains(dropdownEl)) document.body.appendChild(dropdownEl);
  escapeKeyListener = function (ev) {
    if (ev.key === 'Escape' && dropdownVisible) {
      ev.preventDefault();
      hideDropdown();
    }
  };
  document.addEventListener('keydown', escapeKeyListener, true);
}

function hideOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) overlayEl.remove();
  if (escapeKeyListener) {
    document.removeEventListener('keydown', escapeKeyListener, true);
    escapeKeyListener = null;
  }
}

function showDropdown() {
  ensureDropdown();
  showOverlay();
  dropdownEl.style.display = 'block';
  dropdownVisible = true;
}
function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownVisible = false;
  hideOverlay();
}

/* -------------------- Remaining main.js (renderNav etc.) -------------------- */
/* The rest of the file remains unchanged except for a small addition: after renderNav populates #navBar
   it will stay the same (we move the DOM node into sidebar when needed). For brevity, keep rest of original
   renderNav and event wiring below unchanged (copy original content). */

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
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#97a0b3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 [...]
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
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="${activeAcc.username}" style="width:32px;height:32px;border-radius:8px;object-fit:cover"> <span style="color:#1f2a37;font-weight:700">${(activeAcc.displayName || activeAcc.username)}</span>`;
    accountArea.appendChild(avatarBtn);

    const dd = ensureDropdown();
    dd.innerHTML = '';

    avatarBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.innerHTML = `<img src="${avatarUrl}" class="avatar-img" style="width:48px;height:48px;border-radius:8px;object-fit:cover"><div style="flex:1"><div style="font-weight:700">${activeAcc.disp[...]
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
        item.innerHTML = `<img src="${acc.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:36px;height:36px;border-radius:6px;object-fit:cover"><div style="flex:1"><div style[...]
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

    // Notification bell handling
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
      header.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;"><div><strong>การแจ้งเตือน</strong><div class="small">${unreadCount} รา[...]
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
};