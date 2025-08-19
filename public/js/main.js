// public/js/main.js
// Improved header/account/notifications helper
// - Only populates right-side account area (navBar) from partial header
// - Caches API responses briefly and debounces refreshes
// - Robust dropdown positioning and mobile full-width drawer behavior
// - Accessible keyboard handling and cleanup on unload

const API_TIMEOUT = 8000; // ms
const CACHE_TTL = 7000; // ms cache for accounts/notifications
let accountsCache = { data: null, ts: 0 };
let notifsCache = { data: null, ts: 0 };
let refreshDebounceTimer = null;
let dropdownEl = null;
let overlayEl = null;
let dropdownVisible = false;
let activeAnchor = null;
let escapeKeyListener = null;
let outsideClickListener = null;
let resizeListener = null;

function now() { return Date.now(); }

function timeoutFetch(url, opts = {}, ms = API_TIMEOUT) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

async function fetchAccounts(force = false) {
  if (!force && accountsCache.data && (now() - accountsCache.ts) < CACHE_TTL) return accountsCache.data;
  try {
    const r = await timeoutFetch('/api/accounts');
    if (!r.ok) throw new Error('accounts fetch failed');
    const data = await r.json();
    accountsCache = { data, ts: now() };
    return data;
  } catch (e) {
    console.warn('fetchAccounts error', e && e.message);
    return null;
  }
}

async function fetchNotifications(force = false) {
  if (!force && notifsCache.data && (now() - notifsCache.ts) < CACHE_TTL) return notifsCache.data;
  try {
    const r = await timeoutFetch('/api/notifications');
    if (!r.ok) throw new Error('notifications fetch failed');
    const data = await r.json();
    notifsCache = { data, ts: now() };
    return data;
  } catch (e) {
    console.warn('fetchNotifications error', e && e.message);
    return null;
  }
}

function clearCaches() { accountsCache = { data: null, ts: 0 }; notifsCache = { data: null, ts: 0 }; }

// Helper create element from HTML string
function elFrom(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }

// Dropdown / overlay helpers
function ensureDropdown() {
  if (dropdownEl && document.body.contains(dropdownEl)) return dropdownEl;
  dropdownEl = document.createElement('div');
  dropdownEl.id = 'accountDropdown';
  dropdownEl.className = 'dropdown-panel';
  dropdownEl.style.display = 'none';
  dropdownEl.setAttribute('role', 'dialog');
  dropdownEl.setAttribute('aria-hidden', 'true');
  dropdownEl.style.position = 'absolute';
  dropdownEl.style.zIndex = '1600';
  document.body.appendChild(dropdownEl);
  return dropdownEl;
}

function ensureOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.id = 'headerDropdownOverlay';
  overlayEl.style.position = 'fixed';
  overlayEl.style.inset = '0';
  overlayEl.style.background = 'transparent';
  overlayEl.style.zIndex = '1500';
  overlayEl.style.pointerEvents = 'auto';
  overlayEl.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); hideDropdown(); }, { passive: false });
  return overlayEl;
}

function showOverlay() {
  const ov = ensureOverlay();
  if (!document.body.contains(ov)) document.body.appendChild(ov);
  const dd = ensureDropdown();
  if (document.body.contains(dd)) document.body.appendChild(dd);
}
function hideOverlay() { if (overlayEl && document.body.contains(overlayEl)) overlayEl.remove(); }

function trapFocus(container) {
  const focusable = container.querySelectorAll('a,button,input,textarea,select,[tabindex]:not([tabindex="-1"])');
  if (!focusable || focusable.length === 0) return () => {};
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  function onKey(e) {
    if (e.key === 'Tab') {
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}

function showDropdown() {
  const dd = ensureDropdown();
  dd.style.display = 'block';
  dd.setAttribute('aria-hidden', 'false');
  dropdownVisible = true;
  showOverlay();
  escapeKeyListener = (ev) => { if (ev.key === 'Escape' && dropdownVisible) hideDropdown(); };
  document.addEventListener('keydown', escapeKeyListener, true);
}

function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownEl.setAttribute('aria-hidden', 'true');
  dropdownVisible = false;
  hideOverlay();
  if (escapeKeyListener) { document.removeEventListener('keydown', escapeKeyListener, true); escapeKeyListener = null; }
  activeAnchor?.focus?.();
}

function positionDropdown(anchor) {
  const dd = ensureDropdown();
  const winW = window.innerWidth;
  if (!anchor) {
    dd.style.left = ''; dd.style.right = '12px'; dd.style.top = '64px'; return;
  }
  const rect = anchor.getBoundingClientRect();
  if (winW <= 720) {
    dd.style.position = 'fixed';
    dd.style.width = '100%';
    dd.style.left = '0';
    dd.style.right = '0';
    const headerBottom = (document.querySelector('.site-header')?.getBoundingClientRect().bottom) || 64;
    dd.style.top = (headerBottom + 6) + 'px';
  } else {
    dd.style.position = 'absolute';
    const preferWidth = Math.min(420, Math.max(320, rect.width * 2));
    dd.style.width = preferWidth + 'px';
    const right = Math.max(12, window.innerWidth - rect.right - 12);
    dd.style.right = right + 'px';
    dd.style.left = '';
    dd.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  }
}

function safeText(s) { return s ? String(s) : ''; }

// Render functions
async function renderAccountArea() {
  const nav = document.getElementById('navBar');
  if (!nav) return;
  nav.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'header-actions';
  container.style.display = 'flex'; container.style.gap = '10px'; container.style.alignItems = 'center';

  const accData = await fetchAccounts().catch(() => null);
  const notData = await fetchNotifications().catch(() => null);

  // notification bell
  const bell = document.createElement('button');
  bell.className = 'notify-bell';
  bell.setAttribute('aria-label', 'Notifications');
  bell.type = 'button';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#97a0b3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>`;

  let badgeCount = 0;
  if (notData && notData.notifications) {
    const activeName = accData && accData.active ? accData.active : null;
    const filtered = (notData.notifications || []).filter(n => isNotificationFromActive(n, activeName));
    if (filtered.length > 0) {
      const hasReadFlag = Object.prototype.hasOwnProperty.call(filtered[0], 'read');
      badgeCount = hasReadFlag ? filtered.filter(n => !n.read).length : (notData.unread || 0);
    }
  } else if (notData && notData.unread) badgeCount = notData.unread;

  if (badgeCount > 0) {
    const b = document.createElement('div'); b.className = 'notify-badge'; b.innerText = badgeCount > 99 ? '99+' : String(badgeCount); bell.appendChild(b);
  }
  container.appendChild(bell);

  if (accData && accData.accounts && accData.accounts.length > 0) {
    const active = accData.active;
    const accounts = accData.accounts;
    const primary = accounts.find(a => a.username === active) || accounts[0];
    const avatarUrl = primary.profilePic || '/img/default_profile.png';

    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'avatar-btn';
    avatarBtn.type = 'button';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="${primary.username}"> <span style="color:#1f2a37;">${primary.displayName || primary.username}</span>`;
    container.appendChild(avatarBtn);

    // handlers
    avatarBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      activeAnchor = avatarBtn;
      await openAccountDropdown(avatarBtn);
    });

    bell.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      activeAnchor = bell;
      await openNotificationsDropdown(bell);
    });

  } else {
    // no saved accounts
    container.appendChild(elFrom('<a class="btn btn-ghost" href="/login">เข้าสู่ระบบ</a>'));
    container.appendChild(elFrom('<a class="btn btn-primary" href="/register">สมัครสมาชิก</a>'));
  }

  nav.appendChild(container);
}

function isNotificationFromActive(n, activeUsername) {
  if (!activeUsername) return true;
  const a = String(activeUsername);
  const props = ['username','author','actor','from','postAuthor','createdBy','user'];
  for (let p of props) if (n[p] && String(n[p]) === a) return false;
  if (n.post && n.post.username && String(n.post.username) === a) return false;
  if (n.item && n.item.owner && String(n.item.owner) === a) return false;
  return true;
}

async function openAccountDropdown(anchor) {
  const dd = ensureDropdown();
  dd.innerHTML = '';
  const accData = await fetchAccounts(true).catch(() => null);
  if (!accData || !accData.accounts) {
    dd.innerHTML = `<div class="dropdown-header"><div class="small">ไม่สามารถโหลดบัญชีได้</div></div>`;
    positionDropdown(anchor);
    showDropdown();
    return;
  }

  const accounts = accData.accounts; const active = accData.active;
  const primary = accounts.find(a => a.username === active) || accounts[0];

  const header = document.createElement('div'); header.className = 'dropdown-header';
  header.innerHTML = `<img src="${primary.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:40px;height:40px;border-radius:8px"> <div style="flex:1"><div style="font-weight:700">${safeText(primary.displayName || primary.username)}</div><div class="small">@${safeText(primary.username)}</div></div>`;
  dd.appendChild(header);

  const list = document.createElement('div'); list.className = 'dropdown-list'; list.style.maxHeight = '320px'; list.style.overflow = 'auto'; dd.appendChild(list);

  for (let acc of accounts) {
    const item = document.createElement('div'); item.className = 'dropdown-item';
    item.style.display = 'flex'; item.style.alignItems = 'center'; item.style.gap = '8px';
    item.innerHTML = `<img src="${acc.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:36px;height:36px;border-radius:6px"> <div style="flex:1"><div style="font-weight:700">${safeText(acc.displayName || acc.username)}</div><div class="small">@${safeText(acc.username)}</div></div>`;

    if (acc.username === active) {
      const badge = document.createElement('div'); badge.className = 'badge'; badge.style.marginLeft = '8px'; badge.innerText = 'Active';
      item.appendChild(badge);
      item.addEventListener('click', () => { location.href = '/profile'; });
    } else {
      item.style.cursor = 'pointer';
      item.addEventListener('click', async () => {
        if (!confirm(`สลับไปใช้บัญชี ${acc.username} ?`)) return;
        try {
          const r = await fetch('/api/accounts/switch', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username: acc.username }) });
          const d = await r.json();
          if (d && d.success) {
            clearCaches();
            await refreshNav();
            hideDropdown();
            window.dispatchEvent(new Event('accountsChanged'));
          } else alert(d.msg || 'ไม่สามารถสลับบัญชีได้');
        } catch (e) { alert('เกิดข้อผิดพลาดขณะสลับบัญชี'); }
      });
    }
    list.appendChild(item);
  }

  const footer = document.createElement('div'); footer.style.padding = '8px'; footer.style.borderTop = '1px solid rgba(15,23,42,0.04)'; footer.style.display = 'flex'; footer.style.justifyContent = 'space-between';
  footer.innerHTML = `<div><a href="/accounts">Manage accounts</a></div><div><a href="/login?add=1" class="small">Add account</a></div>`;
  dd.appendChild(footer);

  positionDropdown(anchor);
  showDropdown();
}

async function openNotificationsDropdown(anchor) {
  const dd = ensureDropdown(); dd.innerHTML = '';
  const nd = await fetchNotifications(true).catch(() => null);
  const acc = await fetchAccounts().catch(() => null);
  const activeName = acc && acc.active ? acc.active : null;
  const header = document.createElement('div'); header.className = 'dropdown-header';
  let visibleNotifs = [];
  if (nd && nd.notifications) visibleNotifs = (nd.notifications || []).filter(n => isNotificationFromActive(n, activeName));
  const unreadCount = visibleNotifs && visibleNotifs.length > 0 && Object.prototype.hasOwnProperty.call(visibleNotifs[0], 'read') ? visibleNotifs.filter(n => !n.read).length : (nd ? (nd.unread || 0) : 0);
  header.innerHTML = `<div style="flex:1"><strong>Notifications</strong><div class="small">${unreadCount} unread</div></div>`;
  dd.appendChild(header);

  const list = document.createElement('div'); list.style.maxHeight = '320px'; list.style.overflow = 'auto'; list.style.padding = '8px';
  if (!visibleNotifs || visibleNotifs.length === 0) {
    const empty = document.createElement('div'); empty.className = 'dropdown-item'; empty.innerHTML = `<div class="small">ยังไม่มีการแจ้งเตือน</div>`; list.appendChild(empty);
  } else {
    for (let n of visibleNotifs.slice(0, 40)) {
      const it = document.createElement('div'); it.className = 'dropdown-item'; it.style.borderBottom = '1px solid rgba(15,23,42,0.03)';
      it.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px"><div><strong>${safeText(n.type)}</strong><div class="small">${safeText(n.message)}</div></div><div class="small">${new Date(safeText(n.createdAt)||Date.now()).toLocaleString()}</div></div>`;
      if (n.read === false) it.style.background = '#fffef6';
      list.appendChild(it);
    }
    const footer = document.createElement('div'); footer.style.padding='8px'; footer.style.textAlign='right'; footer.innerHTML=`<a href="#" id="markAllRead">Mark all read</a>`; list.appendChild(footer);
  }
  dd.appendChild(list);

  positionDropdown(anchor);
  showDropdown();

  const mar = dd.querySelector('#markAllRead');
  if (mar) mar.addEventListener('click', async (ev) => { ev.preventDefault(); try { await fetch('/api/notifications/mark-read', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) }); clearCaches(); await refreshNav(); hideDropdown(); } catch(e){} });
}

// Public refresh function
async function refreshNav() {
  if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
  return new Promise((resolve) => {
    refreshDebounceTimer = setTimeout(async () => {
      try { await renderAccountArea(); } catch (e) { console.warn('refreshNav error', e && e.message); }
      resolve();
    }, 120);
  });
}

// exported helpers for other scripts
window.refreshNav = refreshNav;
window.openAccountDropdown = async (anchor) => { activeAnchor = anchor || document.querySelector('.avatar-btn'); await openAccountDropdown(activeAnchor); };

// cleanup on unload
function cleanup() {
  hideDropdown();
  if (resizeListener) window.removeEventListener('resize', resizeListener);
  if (outsideClickListener) document.removeEventListener('click', outsideClickListener, true);
}

window.addEventListener('beforeunload', cleanup);

// listen for global accountsChanged
window.addEventListener('accountsChanged', async () => { clearCaches(); await refreshNav(); });

// initial boot
window.addEventListener('DOMContentLoaded', async () => {
  async function tryRender(retries = 3) {
    const nav = document.getElementById('navBar');
    if (!nav && retries > 0) { setTimeout(() => tryRender(retries - 1), 120); return; }
    await refreshNav();
    resizeListener = () => { if (dropdownVisible && activeAnchor) positionDropdown(activeAnchor); };
    window.addEventListener('resize', resizeListener);
    outsideClickListener = (ev) => { if (dropdownVisible && !dropdownEl.contains(ev.target) && !activeAnchor.contains(ev.target)) hideDropdown(); };
    document.addEventListener('click', outsideClickListener, true);
  }
  tryRender();
});

// helper: minimal safe HTML creation
function safeHTML(str) { const d = document.createElement('div'); d.textContent = String(str); return d.innerHTML; }

console.info('header main.js initialized');