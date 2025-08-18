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

/* --------------------
   Local metadata store
   --------------------
   Schema stored at localStorage key: COMMUNITY_ACCOUNTS_V1
   {
     accounts: [
       { username, displayName, profilePic, addedAt, lastUsedAt, order }
     ],
     active: 'username'
   }
   We only store non-sensitive metadata. NEVER store tokens/passwords/session ids here.
*/
const LS_KEY = 'COMMUNITY_ACCOUNTS_V1';
const BC_CHANNEL = 'community:accounts';

function loadLocalMeta() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { accounts: [], active: null };
    return JSON.parse(raw);
  } catch {
    return { accounts: [], active: null };
  }
}

function saveLocalMeta(obj) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
    // broadcast to other tabs
    try {
      if (window.BroadcastChannel) {
        const bc = new BroadcastChannel(BC_CHANNEL);
        bc.postMessage({ type: 'meta:updated', payload: obj });
        bc.close();
      } else {
        // fallback: write to a dedicated storage key (storage event)
        localStorage.setItem(LS_KEY + ':updatedAt', String(Date.now()));
      }
    } catch (e) {
      // ignore
    }
  } catch (e) {
    // ignore quota issues
  }
}

function saveAccountMeta(account) {
  if (!account || !account.username) return;
  const meta = loadLocalMeta();
  const now = Date.now();
  const existingIndex = meta.accounts.findIndex(a => a.username === account.username);
  const entry = {
    username: account.username,
    displayName: account.displayName || account.username,
    profilePic: account.profilePic || '/img/default_profile.png',
    addedAt: existingIndex >= 0 ? meta.accounts[existingIndex].addedAt : now,
    lastUsedAt: now,
    order: existingIndex >= 0 ? meta.accounts[existingIndex].order : (meta.accounts.length || 0)
  };
  if (existingIndex >= 0) meta.accounts[existingIndex] = Object.assign({}, meta.accounts[existingIndex], entry);
  else meta.accounts.push(entry);

  meta.active = account.username;
  saveLocalMeta(meta);
}

function removeAccountMeta(username) {
  if (!username) return;
  const meta = loadLocalMeta();
  meta.accounts = meta.accounts.filter(a => a.username !== username);
  if (meta.active === username) meta.active = meta.accounts.length ? meta.accounts[0].username : null;
  saveLocalMeta(meta);
}

function setActiveAccountMeta(username) {
  if (!username) return;
  const meta = loadLocalMeta();
  const now = Date.now();
  const idx = meta.accounts.findIndex(a => a.username === username);
  if (idx >= 0) {
    meta.accounts[idx].lastUsedAt = now;
    meta.active = username;
    saveLocalMeta(meta);
  } else {
    // if not exist, add minimal entry so UI can show it (but prefer server to return metadata on login)
    meta.accounts.push({ username, displayName: username, profilePic: '/img/default_profile.png', addedAt: now, lastUsedAt: now, order: meta.accounts.length });
    meta.active = username;
    saveLocalMeta(meta);
  }
}

/* Sync: listen for other tabs */
if (window.BroadcastChannel) {
  const bc = new BroadcastChannel(BC_CHANNEL);
  bc.onmessage = (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'meta:updated') {
      // re-render nav to pick up changes
      try { renderNav(); } catch (e) {}
    }
  };
} else {
  // fallback to storage event
  window.addEventListener('storage', (e) => {
    if (e.key === LS_KEY + ':updatedAt') {
      try { renderNav(); } catch (err) {}
    }
  });
}

/* --------------------
   Fetch helpers
   -------------------- */
let globalAccounts = [];
let globalActive = null;
let dropdownEl = null;
let dropdownVisible = false;
let outsidePointerGuard = null;
let outsideKeyGuard = null;

async function fetchAccounts() {
  try {
    const r = await fetch('/api/accounts');
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.success) return data;
    return null;
  } catch {
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
  } catch {
    return null;
  }
}

/* --------------------
   Dropdown guards (prevent underlying activation)
   -------------------- */
function ensureDropdown() {
  if (dropdownEl && document.body.contains(dropdownEl)) return dropdownEl;
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

function addOutsideGuards() {
  outsidePointerGuard = function (ev) {
    if (!dropdownVisible || !dropdownEl) return;
    if (dropdownEl.contains(ev.target)) return;
    // Prevent underlying element activation — close dropdown only
    ev.preventDefault();
    ev.stopPropagation();
    hideDropdown();
  };
  document.addEventListener('pointerdown', outsidePointerGuard, true);

  outsideKeyGuard = function (ev) {
    if (ev.key === 'Escape' && dropdownVisible) {
      ev.preventDefault();
      hideDropdown();
    }
  };
  document.addEventListener('keydown', outsideKeyGuard, true);
}

function removeOutsideGuards() {
  if (outsidePointerGuard) {
    document.removeEventListener('pointerdown', outsidePointerGuard, true);
    outsidePointerGuard = null;
  }
  if (outsideKeyGuard) {
    document.removeEventListener('keydown', outsideKeyGuard, true);
    outsideKeyGuard = null;
  }
}

function showDropdown() {
  const d = ensureDropdown();
  d.style.display = 'block';
  dropdownVisible = true;
  addOutsideGuards();
}
function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownVisible = false;
  removeOutsideGuards();
}

/* --------------------
   Render nav / accounts dropdown
   -------------------- */
function renderAccountListInto(dd, accountsList, activeUsername) {
  dd.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'dropdown-header';
  header.style.padding = '12px';
  header.style.borderBottom = '1px solid #eee';
  const active = accountsList.find(a => a.username === activeUsername) || accountsList[0] || null;
  if (active) {
    header.innerHTML = `<img src="${active.profilePic||'/img/default_profile.png'}" class="avatar-img" style="width:40px;height:40px;margin-right:.5em"><div><div><strong>${active.displayName || active.username}</strong></div><div class="small">${active.username}</div></div>`;
  } else {
    header.innerHTML = `<div style="padding:8px;">ยังไม่มีบัญชี</div>`;
  }
  dd.appendChild(header);

  const list = document.createElement('div');
  list.className = 'dropdown-list';
  list.style.maxHeight = '320px';
  list.style.overflow = 'auto';
  dd.appendChild(list);

  // show accounts EXCEPT active (per your request)
  for (let acc of accountsList) {
    if (acc.username === activeUsername) continue;
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
    item.style.cursor = 'pointer';

    item.onclick = async (e) => {
      if (e.target && e.target.tagName && (e.target.tagName.toLowerCase() === 'button')) return;
      if (!confirm(`สลับไปใช้บัญชี ${acc.username} ?`)) return;
      const r = await fetch('/api/accounts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: acc.username })
      });
      const d = await r.json();
      if (d.success) {
        // server should set session cookie; client updates metadata locally
        setActiveAccountMeta(acc.username);
        await renderNav();
        hideDropdown();
        window.dispatchEvent(new Event('accountsChanged'));
      } else {
        alert(d.msg || 'ไม่สามารถสลับบัญชีได้');
      }
    };

    list.appendChild(item);
  }

  // footer
  const footer = document.createElement('div');
  footer.style.padding = '8px';
  footer.style.borderTop = '1px solid #eee';
  footer.style.display = 'flex';
  footer.style.justifyContent = 'space-between';
  footer.innerHTML = `<div><a href="/accounts" style="text-decoration:none">Manage accounts</a></div><div><button id="dropdownAddBtn">Add account</button></div>`;
  dd.appendChild(footer);

  // attach remove handlers
  dd.querySelectorAll('.btn-remove').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const username = btn.getAttribute('data-username');
      if (!confirm(`ลบบัญชี ${username} จากรายการหรือไม่?`)) return;
      const r = await fetch('/api/accounts/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      const d = await r.json();
      if (d.success) {
        removeAccountMeta(username);
        await renderNav();
        hideDropdown();
        window.dispatchEvent(new Event('accountsChanged'));
      } else {
        alert(d.msg || 'ลบไม่สำเร็จ');
      }
    };
  });

  const addBtn = document.getElementById('dropdownAddBtn');
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.preventDefault();
      // navigate to login page in "add account" mode
      location.href = '/login?add=1';
    };
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
  accountArea.className = 'account-area';

  // Prefer server authoritative data; fallback to local meta when server not available
  let accData = await fetchAccounts();
  let localMeta = loadLocalMeta();

  let accountsToShow = [];
  let activeUsername = null;
  if (accData && accData.accounts) {
    accountsToShow = accData.accounts.map(a => ({ username: a.username, displayName: a.displayName, profilePic: a.profilePic }));
    activeUsername = accData.active;
    // also sync this server info into local store for UX
    // only save non-sensitive metadata
    for (let a of accountsToShow) saveAccountMeta({ username: a.username, displayName: a.displayName, profilePic: a.profilePic });
  } else {
    // fallback: use local meta
    accountsToShow = (localMeta.accounts || []).map(a => ({ username: a.username, displayName: a.displayName, profilePic: a.profilePic }));
    activeUsername = localMeta.active;
  }

  // notification bell
  const notif = await fetchNotifications();
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.style.position = 'relative';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>`;
  if (notif && notif.unread && notif.unread > 0) {
    const badge = document.createElement('div');
    badge.className = 'notify-badge';
    badge.innerText = notif.unread > 99 ? '99+' : notif.unread;
    bell.appendChild(badge);
  }
  accountArea.appendChild(bell);

  if (accountsToShow && accountsToShow.length > 0) {
    const activeAcc = accountsToShow.find(a => a.username === activeUsername) || accountsToShow[0];
    const avatarUrl = activeAcc.profilePic || '/img/default_profile.png';

    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'avatar-btn';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img"> <span style="color:#fff">${activeAcc.displayName || activeAcc.username}</span>`;
    avatarBtn.style.border = 'none';
    avatarBtn.style.background = 'transparent';
    avatarBtn.style.cursor = 'pointer';
    accountArea.appendChild(avatarBtn);

    const dd = ensureDropdown();
    dd.innerHTML = '';

    // clicking avatar toggles dropdown - open immediately (no delay)
    avatarBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      // populate from accountsToShow and activeUsername
      renderAccountListInto(dd, accountsToShow, activeUsername);
      showDropdown();
    });

    // bell click: show notifications in dropdown
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
          await fetch('/api/notifications/mark-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
          hideDropdown();
          await renderNav();
        };
      }

      showDropdown();
    };

  } else {
    accountArea.appendChild(elFrom('<a href="/login">เข้าสู่ระบบ</a>'));
    accountArea.appendChild(elFrom('<a href="/register">สมัครสมาชิก</a>'));
  }

  nav.appendChild(accountArea);
}

/* listen for local accountsChanged */
function setupGlobalRefreshOnMessage() {
  window.addEventListener('accountsChanged', async () => { await renderNav(); });
}
setupGlobalRefreshOnMessage();

/* initialize */
window.addEventListener('load', async () => {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  await renderNav();
});