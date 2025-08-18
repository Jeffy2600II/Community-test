// public/js/main.js
// โหลด partial (header/footer) ด้วย fetch แล้วแทรก
async function loadPartial(id, file) {
  const resp = await fetch(file);
  const html = await resp.text();
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// helper to create element from HTML string
function elFrom(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstChild;
}

/*
  Client-side persistent account storage (no expiry)
  - Key "accounts.saved" : JSON array [{ username, displayName, profilePic }]
  - Key "accounts.active" : username string for active account
*/
const LS_KEYS = {
  ACCOUNTS: 'accounts.saved',
  ACTIVE: 'accounts.active'
};

function getLocalAccounts() {
  try {
    const raw = localStorage.getItem(LS_KEYS.ACCOUNTS);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function setLocalAccounts(arr) {
  try {
    localStorage.setItem(LS_KEYS.ACCOUNTS, JSON.stringify(arr || []));
  } catch { /* ignore */ }
}
function addOrUpdateLocalAccount(acc) {
  if (!acc || !acc.username) return;
  const list = getLocalAccounts();
  const idx = list.findIndex(x => x.username === acc.username);
  if (idx >= 0) list[idx] = { ...list[idx], ...acc };
  else list.push(acc);
  setLocalAccounts(list);
}
function removeLocalAccount(username) {
  if (!username) return;
  const list = getLocalAccounts().filter(a => a.username !== username);
  setLocalAccounts(list);
}
function getLocalActive() {
  return localStorage.getItem(LS_KEYS.ACTIVE) || null;
}
function setLocalActive(username) {
  if (username) localStorage.setItem(LS_KEYS.ACTIVE, username);
  else localStorage.removeItem(LS_KEYS.ACTIVE);
}

// global state
let globalAccounts = [];
let globalActive = null;
let dropdownEl = null;
let dropdownVisible = false;

// Guards / suppression handlers for closing dropdown safely
let outsidePointerGuard = null;
let outsideClickGuard = null;
let outsideKeyGuard = null;
let suppressionTimeoutId = null;
let suppressUntil = 0; // timestamp until which clicks are suppressed (ms)

// --- API helpers (with localStorage fallback/merge) -----------------------
async function fetchAccounts() {
  // Try server API first
  try {
    const r = await fetch('/api/accounts');
    if (r.ok) {
      const data = await r.json();
      if (data && data.success && Array.isArray(data.accounts)) {
        // Merge server accounts with local ones so user-saved accounts persist locally
        const local = getLocalAccounts();
        const merged = mergeAccounts(local, data.accounts);
        // Save merged locally (persist)
        setLocalAccounts(merged);
        // Determine active: prefer server's active if provided, otherwise local
        const active = data.active || getLocalActive() || (merged[0] && merged[0].username) || null;
        if (active) setLocalActive(active);
        return { success: true, accounts: merged, active };
      }
    }
  } catch (err) {
    // fallthrough to local
  }

  // Fallback to localStorage-only view
  const localAccounts = getLocalAccounts();
  const localActive = getLocalActive() || (localAccounts[0] && localAccounts[0].username) || null;
  return { success: true, accounts: localAccounts, active: localActive };
}

// merge two arrays of accounts (unique by username), prefer server data when collision
function mergeAccounts(local, server) {
  const map = new Map();
  (local || []).forEach(a => map.set(a.username, a));
  (server || []).forEach(a => map.set(a.username, { ...map.get(a.username), ...a }));
  return Array.from(map.values());
}

async function fetchNotifications() {
  try {
    const r = await fetch('/api/notifications');
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.success) return data;
    return null;
  } catch {
    return null;
  }
}

// --- Dropdown element creation -------------------------------------------
function ensureDropdown() {
  if (dropdownEl && document.body.contains(dropdownEl)) return dropdownEl;
  // create single dropdown container reused across opens
  dropdownEl = document.createElement('div');
  dropdownEl.id = 'accountDropdown';
  dropdownEl.className = 'dropdown-panel';
  dropdownEl.style.display = 'none';
  dropdownEl.style.position = 'absolute';
  dropdownEl.style.right = '1rem';
  dropdownEl.style.top = '64px';
  dropdownEl.style.zIndex = '999';
  document.body.appendChild(dropdownEl);
  return dropdownEl;
}

// --- Outside-guards: prevent underlying element activation -----------------
// When dropdown is open and user clicks outside, consume that first interaction
// (close dropdown and do not let the underlying target activate). A short
// suppression window prevents the subsequent browser-generated click from firing.
function addOutsideGuards() {
  outsidePointerGuard = function (ev) {
    if (!dropdownVisible || !dropdownEl) return;
    if (dropdownEl.contains(ev.target)) {
      return;
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
    hideDropdown();
    suppressUntil = Date.now() + 300; // 300ms suppression
    if (suppressionTimeoutId) clearTimeout(suppressionTimeoutId);
    suppressionTimeoutId = setTimeout(() => {
      removeOutsideGuards();
    }, 300);
  };

  outsideClickGuard = function (ev) {
    if (Date.now() < suppressUntil) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    if (suppressionTimeoutId) {
      clearTimeout(suppressionTimeoutId);
      suppressionTimeoutId = null;
    }
    removeOutsideGuards();
  };

  outsideKeyGuard = function (ev) {
    if (ev.key === 'Escape' && dropdownVisible) {
      ev.preventDefault();
      hideDropdown();
      removeOutsideGuards();
    }
  };

  document.addEventListener('pointerdown', outsidePointerGuard, true);
  document.addEventListener('click', outsideClickGuard, true);
  document.addEventListener('keydown', outsideKeyGuard, true);
}
function removeOutsideGuards() {
  if (outsidePointerGuard) {
    document.removeEventListener('pointerdown', outsidePointerGuard, true);
    outsidePointerGuard = null;
  }
  if (outsideClickGuard) {
    document.removeEventListener('click', outsideClickGuard, true);
    outsideClickGuard = null;
  }
  if (outsideKeyGuard) {
    document.removeEventListener('keydown', outsideKeyGuard, true);
    outsideKeyGuard = null;
  }
  if (suppressionTimeoutId) {
    clearTimeout(suppressionTimeoutId);
    suppressionTimeoutId = null;
  }
  suppressUntil = 0;
}

// --- show/hide dropdown (open immediately on click) ----------------------
function showDropdown() {
  const d = ensureDropdown();
  d.style.display = 'block';
  dropdownVisible = true;
  // Attach guards immediately; opening happens immediately (no artificial delay)
  addOutsideGuards();
}
function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownVisible = false;
  // If suppression window is active, let timeout handle removal; otherwise remove now
  if (!suppressionTimeoutId) removeOutsideGuards();
}

// --- render nav (uses localStorage merged accounts) -----------------------
async function renderNav() {
  const nav = document.getElementById('navBar');
  if (!nav) return;
  nav.innerHTML = '';

  // left links
  const left = elFrom(`<div style="display:flex;align-items:center;gap:12px;">
    <a href="/">หน้าแรก</a>
    <a href="/post/create">สร้างโพสต์</a>
  </div>`);
  nav.appendChild(left);

  const accountArea = document.createElement('div');
  accountArea.className = 'account-area';

  // fetch accounts & notifications
  const accData = await fetchAccounts();
  const notifData = await fetchNotifications();

  // notification bell
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.style.position = 'relative';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>`;
  if (notifData && notifData.unread && notifData.unread > 0) {
    const badge = document.createElement('div');
    badge.className = 'notify-badge';
    badge.innerText = notifData.unread > 99 ? '99+' : notifData.unread;
    bell.appendChild(badge);
  }
  accountArea.appendChild(bell);

  // If accounts exist, show avatar + name, else show login/register
  if (accData && accData.accounts && accData.accounts.length > 0) {
    globalAccounts = accData.accounts;
    globalActive = accData.active;

    const activeAcc = globalAccounts.find(a => a.username === globalActive) || globalAccounts[0];
    const avatarUrl = activeAcc.profilePic || '/img/default_profile.png';

    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'avatar-btn';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img"> <span style="color:#fff">${activeAcc.displayName || activeAcc.username}</span>`;
    avatarBtn.style.border = 'none';
    avatarBtn.style.background = 'transparent';
    avatarBtn.style.cursor = 'pointer';
    accountArea.appendChild(avatarBtn);

    // ensure dropdown exists and populate when needed
    const dd = ensureDropdown();
    dd.innerHTML = ''; // will populate when opened

    // clicking avatar toggles dropdown and populates immediately
    avatarBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      // populate dropdown immediately
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.style.padding = '12px';
      header.style.borderBottom = '1px solid #eee';
      header.innerHTML = `<img src="${avatarUrl}" class="avatar-img" style="width:40px;height:40px;margin-right:.5em"><div><div><strong>${activeAcc.displayName || activeAcc.username}</strong></div><div class="small">${activeAcc.username}</div></div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.className = 'dropdown-list';
      list.style.maxHeight = '320px';
      list.style.overflow = 'auto';
      dd.appendChild(list);

      // Build account items: DO NOT show the active account as selectable
      for (let acc of globalAccounts) {
        if (acc.username === globalActive) continue;

        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.padding = '10px 12px';
        item.style.gap = '0.6rem';
        item.innerHTML = `<img src="${acc.profilePic||'/img/default_profile.png'}" class="avatar-img" style="width:32px;height:32px">
          <div style="flex:1">
            <div><strong>${acc.displayName || acc.username}</strong></div>
            <div class="small">${acc.username}</div>
          </div>
          <div style="min-width:80px; text-align:right;"><button class="btn-remove small" data-username="${acc.username}">Remove</button></div>`;

        // clicking the item (row) will switch account
        item.style.cursor = 'pointer';
        item.onclick = async (e) => {
          if (e.target && e.target.tagName && (e.target.tagName.toLowerCase() === 'button')) return;
          const confirmSwitch = confirm(`สลับไปใช้บัญชี ${acc.username} ?`);
          if (!confirmSwitch) return;
          const r = await fetch('/api/accounts/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: acc.username })
          });
          const d = await r.json();
          if (d.success) {
            // update local active as well
            setLocalActive(acc.username);
            await renderNav();
            hideDropdown();
            window.dispatchEvent(new Event('accountsChanged'));
          } else {
            alert(d.msg || 'ไม่สามารถสลับบัญชีได้');
          }
        };

        list.appendChild(item);
      }

      // "Add account" control at bottom -> go to /login?add=1
      const footer = document.createElement('div');
      footer.style.padding = '8px';
      footer.style.borderTop = '1px solid #eee';
      footer.style.display = 'flex';
      footer.style.justifyContent = 'space-between';
      footer.innerHTML = `<div><a href="/accounts" style="text-decoration:none">Manage accounts</a></div><div><button id="dropdownAddBtn">Add account</button></div>`;
      dd.appendChild(footer);

      // attach remove handlers
      list.querySelectorAll('.btn-remove').forEach(btn => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          const username = btn.getAttribute('data-username');
          if (!confirm(`ลบบัญชี ${username} จากรายการหรือไม่?`)) return;
          try {
            const r = await fetch('/api/accounts/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username })
            });
            const d = await r.json();
            if (d.success) {
              removeLocalAccount(username);
              await renderNav();
              hideDropdown();
              window.dispatchEvent(new Event('accountsChanged'));
            } else {
              alert(d.msg || 'ลบไม่สำเร็จ');
            }
          } catch {
            // If API failed, still remove locally
            removeLocalAccount(username);
            await renderNav();
            hideDropdown();
            window.dispatchEvent(new Event('accountsChanged'));
          }
        };
      });

      // add account button -> go to /login?add=1
      const addBtn = document.getElementById('dropdownAddBtn');
      if (addBtn) {
        addBtn.onclick = (e) => {
          e.preventDefault();
          location.href = '/login?add=1';
        };
      }

      showDropdown();
    };

    // bell click: open notifications list within dropdown
    bell.onclick = async (ev) => {
      ev.stopPropagation();
      const dd = ensureDropdown();
      const nd = await fetchNotifications();
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.style.padding = '8px';
      header.innerHTML = `<strong>Notifications</strong> <span class="small" style="float:right">${nd ? (nd.unread||0) : 0} unread</span>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.style.maxHeight = '320px';
      list.style.overflow = 'auto';
      list.style.padding = '8px';
      if (!nd || !nd.notifications || nd.notifications.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dropdown-item';
        empty.innerHTML = `<div class="small">ยังไม่มีการแจ้งเตือน</div>`;
        list.appendChild(empty);
      } else {
        for (let n of nd.notifications.slice(0, 30)) {
          const it = document.createElement('div');
          it.className = 'dropdown-item';
          it.style.padding = '.6rem';
          it.style.borderBottom = '1px solid #f0f0f0';
          it.innerHTML = `<div style="display:flex;justify-content:space-between;">
            <div><strong>${n.type}</strong><div class="small">${n.message}</div></div>
            <div class="small">${new Date(n.createdAt).toLocaleString()}</div>
          </div>`;
          list.appendChild(it);
        }
        const footer = document.createElement('div');
        footer.style.padding = '8px';
        footer.style.textAlign = 'right';
        footer.innerHTML = `<a href="#" id="markAllRead">Mark all read</a>`;
        list.appendChild(footer);
      }
      dd.appendChild(list);

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

      showDropdown();
    };

  } else {
    // show auth links if no accounts saved
    accountArea.appendChild(elFrom('<a href="/login">เข้าสู่ระบบ</a>'));
    accountArea.appendChild(elFrom('<a href="/register">สมัครสมาชิก</a>'));
  }

  nav.appendChild(accountArea);
}

// Listen to external events (other pages) to refresh header
function setupGlobalRefreshOnMessage() {
  window.addEventListener('accountsChanged', async () => {
    await renderNav();
  });
}

// initialize
window.onload = async function() {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  setupGlobalRefreshOnMessage();
  renderNav();
};

// Utility exported for other pages that may want to modify local saved accounts
window.__accountsLocal = {
  addOrUpdateLocalAccount,
  removeLocalAccount,
  setLocalActive,
  getLocalAccounts,
  getLocalActive
};