// public/js/main.js
// โหลด partial (header/footer) ด้วย fetch แล้วแทรก
async function loadPartial(id, file) {
  try {
    const resp = await fetch(file);
    const html = await resp.text();
    const slot = document.getElementById(id);
    if (slot) slot.innerHTML = html;
  } catch (e) {
    // ignore
  }
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
  dropdownEl.style.zIndex = '999';
  dropdownEl.style.minWidth = '260px';
  dropdownEl.style.boxShadow = '0 6px 18px rgba(0,0,0,.08)';
  dropdownEl.style.background = '#fff';
  dropdownEl.style.borderRadius = '8px';
  dropdownEl.style.overflow = 'hidden';
  document.body.appendChild(dropdownEl);

  // click outside -> hide
  document.addEventListener('click', (ev) => {
    if (!dropdownEl) return;
    if (dropdownVisible) {
      const rect = dropdownEl.getBoundingClientRect();
      const x = ev.clientX, y = ev.clientY;
      if (!(x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
        hideDropdown();
      }
    }
  });

  return dropdownEl;
}

function showDropdown() {
  const d = ensureDropdown();
  d.style.display = 'block';
  dropdownVisible = true;
}
function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownVisible = false;
}

/**
 * Attempts to switch to the given username.
 * API expected: POST /api/accounts/switch { username }
 * Response: { success: true, reload?: boolean, msg?: string }
 */
async function switchAccount(username) {
  try {
    const r = await fetch('/api/accounts/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const d = await r.json();
    if (!d || !d.success) {
      alert(d && d.msg ? d.msg : 'ไม่สามารถสลับบัญชีได้');
      return false;
    }
    // If server requests a full reload (to pick up HttpOnly cookies / session), do it.
    if (d.reload) {
      location.reload();
      return true; // will reload
    }
    // Otherwise re-fetch accounts and re-render header
    await renderNav();
    // notify other parts of the app that accounts changed
    window.dispatchEvent(new Event('accountsChanged'));
    return true;
  } catch (err) {
    alert('เกิดข้อผิดพลาดขณะสลับบัญชี');
    return false;
  }
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
  accountArea.style.display = 'flex';
  accountArea.style.alignItems = 'center';
  accountArea.style.gap = '12px';

  // fetch accounts & notifications
  const accData = await fetchAccounts();
  const notifData = await fetchNotifications();

  // notification bell
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.style.position = 'relative';
  bell.style.cursor = 'pointer';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>`;
  if (notifData && notifData.unread && notifData.unread > 0) {
    const badge = document.createElement('div');
    badge.className = 'notify-badge';
    badge.innerText = notifData.unread > 99 ? '99+' : notifData.unread;
    badge.style.position = 'absolute';
    badge.style.top = '-6px';
    badge.style.right = '-6px';
    badge.style.background = '#d33';
    badge.style.color = '#fff';
    badge.style.padding = '2px 6px';
    badge.style.borderRadius = '12px';
    badge.style.fontSize = '11px';
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
    avatarBtn.style.display = 'flex';
    avatarBtn.style.alignItems = 'center';
    avatarBtn.style.gap = '8px';
    avatarBtn.style.border = 'none';
    avatarBtn.style.background = 'transparent';
    avatarBtn.style.cursor = 'pointer';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img" style="width:34px;height:34px;border-radius:6px;object-fit:cover;"> <span style="color:#111">${activeAcc.displayName || activeAcc.username}</span>`;
    accountArea.appendChild(avatarBtn);

    // ensure dropdown exists and populate when needed
    const dd = ensureDropdown();
    dd.innerHTML = ''; // will populate when opened

    // clicking avatar toggles dropdown and populates
    avatarBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      // populate dropdown
      dd.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.style.padding = '12px';
      header.style.borderBottom = '1px solid #eee';
      header.innerHTML = `<div style="display:flex;align-items:center;gap:10px;">
        <img src="${avatarUrl}" class="avatar-img" style="width:40px;height:40px;border-radius:6px;object-fit:cover;">
        <div><div style="font-weight:700">${activeAcc.displayName || activeAcc.username}</div><div class="small" style="color:#666">${activeAcc.username}</div></div>
      </div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.className = 'dropdown-list';
      list.style.maxHeight = '320px';
      list.style.overflow = 'auto';
      list.style.padding = '6px 6px';
      dd.appendChild(list);

      // Build account items: DO NOT show the active account as selectable
      for (let acc of globalAccounts) {
        // SKIP active account so it's not shown as selectable
        if (acc.username === globalActive) continue;

        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.padding = '8px';
        item.style.gap = '0.6rem';
        item.style.borderRadius = '6px';
        item.style.cursor = 'pointer';
        item.style.transition = 'background .12s';
        item.onmouseover = () => item.style.background = '#fafafa';
        item.onmouseout = () => item.style.background = 'transparent';

        item.innerHTML = `<img src="${acc.profilePic||'/img/default_profile.png'}" class="avatar-img" style="width:36px;height:36px;border-radius:6px;object-fit:cover">
          <div style="flex:1">
            <div style="font-weight:600">${acc.displayName || acc.username}</div>
            <div class="small" style="color:#666">${acc.username}</div>
          </div>
          <div style="min-width:96px; text-align:right;">
            <button class="btn-remove small" data-username="${acc.username}" style="margin-left:8px">Remove</button>
          </div>`;

        // clicking the item (row) will switch account
        item.onclick = async (e) => {
          // prevent remove button click bubbling
          if (e.target && e.target.tagName && (e.target.tagName.toLowerCase() === 'button')) return;
          if (!confirm(`สลับไปใช้บัญชี ${acc.username} ?`)) return;
          // disable interactions briefly
          item.style.pointerEvents = 'none';
          const ok = await switchAccount(acc.username);
          if (!ok) item.style.pointerEvents = ''; // re-enable if failed
          else hideDropdown();
        };

        list.appendChild(item);
      }

      // "Add account" control at bottom -> นำไปที่หน้า login?add=1
      const footer = document.createElement('div');
      footer.style.padding = '10px';
      footer.style.borderTop = '1px solid #eee';
      footer.style.display = 'flex';
      footer.style.justifyContent = 'space-between';
      footer.style.alignItems = 'center';
      footer.innerHTML = `<div><a href="/accounts" style="text-decoration:none;color:#333">Manage accounts</a></div><div><button id="dropdownAddBtn">Add account</button></div>`;
      dd.appendChild(footer);

      // attach remove handlers (delegated)
      list.querySelectorAll('.btn-remove').forEach(btn => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          const username = btn.getAttribute('data-username');
          if (!confirm(`ลบบัญชี ${username} จากรายการหรือไม่?`)) return;
          btn.disabled = true;
          try {
            const r = await fetch('/api/accounts/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username })
            });
            const d = await r.json();
            if (d && d.success) {
              await renderNav();
              hideDropdown();
              window.dispatchEvent(new Event('accountsChanged'));
            } else {
              alert(d && d.msg ? d.msg : 'ลบไม่สำเร็จ');
              btn.disabled = false;
            }
          } catch {
            alert('เกิดข้อผิดพลาด');
            btn.disabled = false;
          }
        };
      });

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

// Listen for external updates (other pages can dispatch this)
function setupGlobalRefreshOnMessage() {
  window.addEventListener('accountsChanged', async () => {
    await renderNav();
  });
}

// initialize
window.addEventListener('load', async function() {
  // try to fill header/footer used by pages that include slots
  try { await loadPartial('headerSlot', '/partial/header.html'); } catch {}
  try { await loadPartial('footerSlot', '/partial/footer.html'); } catch {}
  setupGlobalRefreshOnMessage();
  await renderNav();
});