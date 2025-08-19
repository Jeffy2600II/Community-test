// public/js/main.js (ปรับปรุงการวาง dropdown ให้แน่นขึ้น + responsive behavior)
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

let globalAccounts = [];
let globalActive = null;
let dropdownEl = null;
let dropdownVisible = false;
let overlayEl = null;
let escapeKeyListener = null;

async function fetchAccounts() {
  try {
    const r = await fetch('/api/accounts');
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.success) return data;
    return null;
  } catch { return null; }
}
async function fetchNotifications() {
  try {
    const r = await fetch('/api/notifications');
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.success) return data;
    return null;
  } catch { return null; }
}

function ensureDropdown() {
  if (dropdownEl && document.body.contains(dropdownEl)) return dropdownEl;
  dropdownEl = document.createElement('div');
  dropdownEl.id = 'accountDropdown';
  dropdownEl.className = 'dropdown-panel';
  dropdownEl.style.display = 'none';
  dropdownEl.style.position = 'absolute';
  dropdownEl.style.zIndex = '1400';
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

async function positionDropdownRelativeTo(anchorEl) {
  const dd = ensureDropdown();
  // default width
  const winW = window.innerWidth;
  if (winW <= 720) {
    // mobile: full width under header
    dd.style.width = '100%';
    dd.style.left = '0px';
    dd.style.right = '';
    const top = (document.querySelector('.site-header')?.getBoundingClientRect().bottom || 68) + window.scrollY;
    dd.style.top = (top + 8) + 'px';
  } else {
    // desktop: align right edge of dropdown to right edge of anchor or container
    const rect = anchorEl.getBoundingClientRect();
    const ddWidth = Math.min(420, Math.max(320, rect.width * 2));
    dd.style.width = ddWidth + 'px';
    // prefer right align to the anchor's right
    const right = window.innerWidth - rect.right - 12;
    dd.style.right = Math.max(12, right) + 'px';
    dd.style.left = '';
    dd.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  }
}

async function renderNav() {
  const nav = document.getElementById('navBar');
  if (!nav) return;
  nav.innerHTML = '';

  const left = elFrom(`<div style="display:flex;align-items:center;gap:12px;">
    <a href="/">หน้าแรก</a>
    <a href="/post/create">สร้างโพสต์</a>
  </div>`);
  nav.appendChild(left);

  const accountArea = document.createElement('div');
  accountArea.className = 'header-actions';
  accountArea.style.display = 'flex';
  accountArea.style.alignItems = 'center';
  accountArea.style.gap = '10px';

  const accData = await fetchAccounts();
  const notifData = await fetchNotifications();

  // notification bell
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.setAttribute('role','button');
  bell.setAttribute('aria-label','Notifications');
  bell.style.cursor = 'pointer';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#97a0b3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>`;
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
    bell.appendChild(badge);
  }
  accountArea.appendChild(bell);

  if (accData && accData.accounts && accData.accounts.length > 0) {
    globalAccounts = accData.accounts;
    globalActive = accData.active;
    const activeAcc = globalAccounts.find(a => a.username === globalActive) || globalAccounts[0];
    const avatarUrl = activeAcc.profilePic || '/img/default_profile.png';

    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'avatar-btn';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="${activeAcc.username}"> <span style="color:#1f2a37">${activeAcc.displayName || activeAcc.username}</span>`;
    avatarBtn.type = 'button';
    accountArea.appendChild(avatarBtn);

    const dd = ensureDropdown();
    dd.innerHTML = '';

    avatarBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.innerHTML = `<img src="${avatarUrl}" class="avatar-img" style="width:40px;height:40px;border-radius:8px"> <div style="flex:1"><div style="font-weight:700">${activeAcc.displayName || activeAcc.username}</div><div class="small">${activeAcc.username}</div></div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.className = 'dropdown-list';
      dd.appendChild(list);

      for (let acc of globalAccounts) {
        if (acc.username === globalActive) continue;
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.innerHTML = `<img src="${acc.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:32px;height:32px;border-radius:6px"><div style="flex:1"><div style="font-weight:700">${acc.displayName || acc.username}</div><div class="small">${acc.username}</div></div>`;
        item.onclick = async (e) => {
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
      footer.innerHTML = `<div><a href="/accounts">Manage accounts</a></div><div><a href="/login?add=1" class="small">Add account</a></div>`;
      dd.appendChild(footer);

      await positionDropdownRelativeTo(avatarBtn);
      showDropdown();
    };

    bell.onclick = async (ev) => {
      ev.stopPropagation();
      const nd = await fetchNotifications();
      const dd = ensureDropdown();
      dd.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'dropdown-header';
      let visibleNotifs = [];
      if (nd && nd.notifications) visibleNotifs = (nd.notifications || []).filter(n => isNotificationFromActive(n, globalActive));
      const unreadCount = visibleNotifs && visibleNotifs.length > 0 && Object.prototype.hasOwnProperty.call(visibleNotifs[0], 'read')
        ? visibleNotifs.filter(n => !n.read).length
        : (nd ? (nd.unread || 0) : 0);
      header.innerHTML = `<div style="flex:1"><strong>Notifications</strong><div class="small">${unreadCount} unread</div></div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.style.maxHeight = '320px';
      list.style.overflow = 'auto';
      list.style.padding = '8px';
      if (!visibleNotifs || visibleNotifs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dropdown-item';
        empty.innerHTML = `<div class="small">ยังไม่มีการแจ้งเตือน</div>`;
        list.appendChild(empty);
      } else {
        for (let n of visibleNotifs.slice(0, 30)) {
          const it = document.createElement('div');
          it.className = 'dropdown-item';
          it.style.borderBottom = '1px solid rgba(15,23,42,0.03)';
          it.innerHTML = `<div style="display:flex;justify-content:space-between;"><div><strong>${n.type}</strong><div class="small">${n.message}</div></div><div class="small">${new Date(n.createdAt).toLocaleString()}</div></div>`;
          list.appendChild(it);
        }
        const footer = document.createElement('div');
        footer.style.padding = '8px';
        footer.style.textAlign = 'right';
        footer.innerHTML = `<a href="#" id="markAllRead">Mark all read</a>`;
        list.appendChild(footer);
      }
      dd.appendChild(list);

      const anchor = bell;
      await positionDropdownRelativeTo(anchor);
      showDropdown();

      const mar = dd.querySelector('#markAllRead');
      if (mar) {
        mar.onclick = async (ev) => {
          ev.preventDefault();
          await fetch('/api/notifications/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
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

function setupGlobalRefreshOnMessage() {
  window.addEventListener('accountsChanged', async () => {
    await renderNav();
  });
}

window.onload = async function() {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  setupGlobalRefreshOnMessage();
  await renderNav();
};