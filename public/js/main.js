// public/js/main.js
// โหลด partial (header/footer) ด้วย fetch แล้วแทรก
async function loadPartial(id, file) {
  const resp = await fetch(file);
  const html = await resp.text();
  document.getElementById(id).innerHTML = html;
}

// helper to create element from HTML string
function elFrom(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstChild;
}

let globalAccounts = [];
let globalActive = null;
let dropdownEl = null;
let dropdownVisible = false;

// overlay element that sits above the page but under the dropdown to swallow clicks
let overlayEl = null;
// escape key listener reference
let escapeKeyListener = null;

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
  dropdownEl.style.zIndex = '1001'; // above overlay
  document.body.appendChild(dropdownEl);
  return dropdownEl;
}

function createOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.id = 'dropdownOverlay';
  // full screen invisible overlay
  overlayEl.style.position = 'fixed';
  overlayEl.style.inset = '0';
  overlayEl.style.background = 'transparent';
  // put overlay under the dropdown (dropdown zIndex is 1001)
  overlayEl.style.zIndex = '1000';
  // ensure it captures pointer events
  overlayEl.style.pointerEvents = 'auto';

  // clicking the overlay only closes dropdown and prevents any other action
  overlayEl.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    // hide dropdown (which will remove overlay)
    hideDropdown();
  }, { passive: false });

  // also prevent contextmenu / auxiliary clicks from propagating to underlying elements
  overlayEl.addEventListener('auxclick', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }, { passive: false });

  overlayEl.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }, { passive: false });

  return overlayEl;
}

function showOverlay() {
  const ov = createOverlay();
  // append overlay to body if not present
  if (!document.body.contains(ov)) document.body.appendChild(ov);
  // ensure dropdown is after overlay in DOM so it appears above
  if (dropdownEl && document.body.contains(dropdownEl)) {
    document.body.appendChild(dropdownEl);
  }
  // attach escape key listener
  escapeKeyListener = function (ev) {
    if (ev.key === 'Escape' && dropdownVisible) {
      ev.preventDefault();
      hideDropdown();
    }
  };
  document.addEventListener('keydown', escapeKeyListener, true);
}

function hideOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) {
    // remove overlay so clicks go through again
    overlayEl.remove();
  }
  if (escapeKeyListener) {
    document.removeEventListener('keydown', escapeKeyListener, true);
    escapeKeyListener = null;
  }
}

function showDropdown() {
  const d = ensureDropdown();
  // show overlay first so it captures clicks; dropdown appended above overlay
  showOverlay();
  d.style.display = 'block';
  dropdownVisible = true;
}

function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownVisible = false;
  hideOverlay();
}

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

  // notification bell (simple svg)
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.style.position = 'relative';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>`;

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

    // clicking avatar toggles dropdown and populates
    avatarBtn.onclick = async (ev) => {
      // stopPropagation so our own handlers don't immediately close it
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      // populate dropdown
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.style.padding = '12px';
      header.style.borderBottom = '1px solid #eee';
      header.innerHTML = `<div style="display:flex;align-items:center;gap:.5em;"><img src="${avatarUrl}" class="avatar-img" style="width:40px;height:40px;border-radius:50%"><div><div><strong>${activeAcc.displayName || activeAcc.username}</strong></div><div class="small">${activeAcc.username}</div></div></div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.className = 'dropdown-list';
      list.style.maxHeight = '320px';
      list.style.overflow = 'auto';
      dd.appendChild(list);

      // Build account items: DO NOT show the active account as selectable
      for (let acc of globalAccounts) {
        // SKIP active account so it's not shown as selectable
        if (acc.username === globalActive) continue;

        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.padding = '10px 12px';
        item.style.gap = '0.6rem';
        item.innerHTML = `<img src="${acc.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:32px;height:32px;border-radius:50%">
          <div style="flex:1">
            <div><strong>${acc.displayName || acc.username}</strong></div>
            <div class="small">${acc.username}</div>
          </div>`;

        // clicking the item (row) will switch account
        item.style.cursor = 'pointer';
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
              // refresh UI state: re-fetch accounts and notifications and re-render navbar
              await renderNav();
              hideDropdown();
              // notify other parts of the app (optional)
              window.dispatchEvent(new Event('accountsChanged'));
            } else {
              alert(d.msg || 'ไม่สามารถสลับบัญชีได้');
            }
          } catch (err) {
            alert('เกิดข้อผิดพลาดขณะสลับบัญชี');
          }
        };

        list.appendChild(item);
      }

      // "Add account" control at bottom -> นำไปที่หน้า /login?add=1
      const footer = document.createElement('div');
      footer.style.padding = '8px';
      footer.style.borderTop = '1px solid #eee';
      footer.style.display = 'flex';
      footer.style.justifyContent = 'space-between';
      footer.innerHTML = `<div><a href="/accounts" style="text-decoration:none">Manage accounts</a></div><div><button id="dropdownAddBtn">Add account</button></div>`;
      dd.appendChild(footer);

      // add account button -> ไปหน้า /login?add=1
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
      // fetch notifications
      const nd = await fetchNotifications();
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.style.padding = '8px';
      header.innerHTML = `<strong>Notifications</strong> <span class="small" style="float:right">${nd ? (nd.unread || 0) : 0} unread</span>`;
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

      // attach mark all read
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
          // refresh nav to update badge
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

// Modal: The main header code no longer creates its own add-account modal.
// We rely on /accounts page for full manage UI. However we keep helper functions
// to refresh nav after performing account actions on that page.
function setupGlobalRefreshOnMessage() {
  // Listen for custom event from other pages (like /accounts) to refresh header instantly
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

// Utility to dispatch accountsChanged from other views after add/remove/switch
// (Other pages can call: window.dispatchEvent(new Event('accountsChanged')) )