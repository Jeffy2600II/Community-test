// public/js/main.js
// โหลด partial (header/footer) ด้วย fetch แล้วแทรก
async function loadPartial(id, file) {
  const resp = await fetch(file);
  const html = await resp.text();
  document.getElementById(id).innerHTML = html;
}

// small helper to create element from HTML
function elFrom(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstChild;
}

// Render Navbar (inspired by GitHub UX)
let globalAccounts = [];
let globalActive = null;
let dropdownOpen = false;
let notifOpen = false;

async function renderNav() {
  // basic left links will be rendered by partial; here we render account area to the right
  // fetch accounts and notifications
  let accountsData = null;
  try {
    const accResp = await fetch('/api/accounts');
    if (accResp.ok) {
      accountsData = await accResp.json();
    }
  } catch (e) {
    accountsData = null;
  }

  // ensure navBar exists
  const nav = document.getElementById('navBar');
  if (!nav) return;

  // clear
  nav.innerHTML = '';

  // left links
  const leftLinks = elFrom(`<div style="display:flex;align-items:center;gap:12px;">
    <a href="/">หน้าแรก</a>
    <a href="/post/create">สร้างโพสต์</a>
  </div>`);
  nav.appendChild(leftLinks);

  // account area (right)
  const accountArea = document.createElement('div');
  accountArea.className = 'account-area';

  // notifications bell
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>`;
  accountArea.appendChild(bell);

  // avatar button (if accounts present show avatar of active else login link)
  if (accountsData && accountsData.accounts && accountsData.accounts.length > 0) {
    globalAccounts = accountsData.accounts;
    globalActive = accountsData.active;

    // show badge count (notifications)
    try {
      const nresp = await fetch('/api/notifications');
      if (nresp.ok) {
        const nd = await nresp.json();
        if (nd && typeof nd.unread === 'number' && nd.unread > 0) {
          const badge = document.createElement('div');
          badge.className = 'notify-badge';
          badge.innerText = nd.unread > 99 ? '99+' : nd.unread;
          bell.appendChild(badge);
        }
      }
    } catch {}

    const activeAcc = globalAccounts.find(a => a.username === globalActive) || globalAccounts[0];
    const avatarUrl = activeAcc.profilePic || '/img/default_profile.png';
    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'avatar-btn';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img"> <span style="color:#fff">${activeAcc.displayName || activeAcc.username}</span>`;
    accountArea.appendChild(avatarBtn);

    // dropdown panel placeholder
    const dropdown = document.createElement('div');
    dropdown.className = 'dropdown-panel';
    dropdown.style.display = 'none';
    dropdown.innerHTML = `<div class="dropdown-header">
        <img src="${avatarUrl}" class="avatar-img">
        <div>
          <div><strong>${activeAcc.displayName || activeAcc.username}</strong></div>
          <div class="small">${activeAcc.username}</div>
        </div>
      </div>
      <div class="dropdown-list" id="accountDropdownList"></div>
      <div style="padding:8px;border-top:1px solid #eee;display:flex;gap:.5rem;justify-content:space-between;">
        <a href="/profile/edit">Settings</a>
        <a href="/accounts" id="manageAccountsLink">Manage accounts</a>
        <a href="#" id="signOutTop">Sign out</a>
      </div>`;
    document.body.appendChild(dropdown);

    // event handlers
    avatarBtn.onclick = (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      notifPanelHide();
      renderAccountDropdown();
    };

    // bell click toggles notifications panel (reuse dropdown panel for simplicity)
    bell.onclick = async (e) => {
      e.stopPropagation();
      // load notifications and show in dropdown panel
      try {
        const nr = await fetch('/api/notifications');
        if (!nr.ok) throw new Error('no');
        const nd = await nr.json();
        dropdown.style.display = 'block';
        const listEl = dropdown.querySelector('#accountDropdownList');
        listEl.innerHTML = '';
        const header = document.createElement('div');
        header.style.padding = '8px';
        header.innerHTML = `<strong>Notifications</strong> <span class="small" style="float:right">${nd.unread||0} unread</span>`;
        listEl.appendChild(header);
        if (nd.notifications && nd.notifications.length) {
          for (let n of nd.notifications.slice(0, 25)) {
            const it = document.createElement('div');
            it.className = 'dropdown-item';
            it.innerHTML = `<div style="flex:1">
                <div><strong>${n.type}</strong></div>
                <div class="small">${n.message}</div>
                <div class="small">${new Date(n.createdAt).toLocaleString()}</div>
              </div>
              <div style="margin-left:8px;"><input data-id="${n.id}" type="checkbox" ${n.read ? 'checked' : ''} /></div>`;
            listEl.appendChild(it);
          }
          // footer action
          const footer = document.createElement('div');
          footer.style.padding = '8px';
          footer.style.borderTop = '1px solid #eee';
          footer.style.textAlign = 'right';
          footer.innerHTML = `<a href="#" id="markAllRead">Mark all read</a>`;
          listEl.appendChild(footer);

          // mark all read handler
          setTimeout(()=> {
            const mar = document.getElementById('markAllRead');
            if (mar) mar.onclick = async (ev) => {
              ev.preventDefault();
              await fetch('/api/notifications/mark-read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
              });
              location.reload();
            };
          }, 10);
        } else {
          const it = document.createElement('div');
          it.className = 'dropdown-item';
          it.innerHTML = `<div class="small">ยังไม่มีการแจ้งเตือน</div>`;
          listEl.appendChild(it);
        }
      } catch (err) {
        alert('ไม่สามารถโหลดการแจ้งเตือนได้');
      }
      // hide avatar dropdown content will be replaced next time user opens
    };

    // sign out
    document.addEventListener('click', (ev) => {
      if (dropdown.style.display === 'block') {
        // hide if clicked outside
        const rect = dropdown.getBoundingClientRect();
        const x = ev.clientX, y = ev.clientY;
        if (!(x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
          dropdown.style.display = 'none';
        }
      }
    });

    // renderAccountDropdown builds content in #accountDropdownList
    function renderAccountDropdown() {
      const listEl = dropdown.querySelector('#accountDropdownList');
      listEl.innerHTML = '';
      // accounts list with switching and remove
      for (let acc of globalAccounts) {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.innerHTML = `<img src="${acc.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:32px;height:32px">
          <div style="flex:1">
            <div><strong>${acc.displayName || acc.username}</strong></div>
            <div class="small">${acc.username}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <button class="btn-switch small" data-username="${acc.username}" style="padding:.3em .5em;">Use</button>
            <button class="btn-remove small" data-username="${acc.username}" style="padding:.3em .5em;background:#eee;">Remove</button>
          </div>`;
        listEl.appendChild(item);
      }
      // add "add account" button
      const addWrap = document.createElement('div');
      addWrap.style.padding = '8px';
      addWrap.innerHTML = `<button id="dropdownAddAccount">Add account</button>`;
      listEl.appendChild(addWrap);

      // attach handlers
      setTimeout(()=> {
        dropdown.querySelectorAll('.btn-switch').forEach(b => {
          b.onclick = async (ev) => {
            ev.preventDefault();
            const username = b.getAttribute('data-username');
            if (!confirm(`สลับไปใช้บัญชี ${username} ?`)) return;
            const r = await fetch('/api/accounts/switch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username })
            });
            const d = await r.json();
            if (d.success) location.reload(); else alert(d.msg || 'ไม่สำเร็จ');
          };
        });
        dropdown.querySelectorAll('.btn-remove').forEach(b => {
          b.onclick = async (ev) => {
            ev.preventDefault();
            const username = b.getAttribute('data-username');
            if (!confirm(`ลบบัญชี ${username} จากรายการ?`)) return;
            const r = await fetch('/api/accounts/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username })
            });
            const d = await r.json();
            if (d.success) location.reload(); else alert(d.msg || 'ไม่สำเร็จ');
          };
        });
        const ddAdd = document.getElementById('dropdownAddAccount');
        if (ddAdd) ddAdd.onclick = (ev) => {
          ev.preventDefault();
          showAddAccountModal();
        };
        const signOutTop = document.getElementById('signOutTop');
        if (signOutTop) signOutTop.onclick = async (ev) => {
          ev.preventDefault();
          if (!confirm('ยืนยันออกจากระบบ?')) return;
          await fetch('/api/logout', { method: 'POST' });
          location.reload();
        };
        const manageLink = document.getElementById('manageAccountsLink');
        if (manageLink) manageLink.onclick = (ev) => {
          // let it follow link to /accounts
        };
      }, 20);
    }

  } else {
    // no accounts saved -> show auth links
    const loginLink = elFrom('<a href="/login">เข้าสู่ระบบ</a>');
    const regLink = elFrom('<a href="/register">สมัครสมาชิก</a>');
    accountArea.appendChild(loginLink);
    accountArea.appendChild(regLink);
  }

  nav.appendChild(accountArea);
}

// Modal: add account
function showAddAccountModal() {
  const modal = document.getElementById('addAccountModal');
  if (!modal) return alert('ไม่พบ UI สำหรับเพิ่มบัญชี');
  document.getElementById('addAccountMsg').innerText = '';
  document.querySelector('#addAccountForm input[name=email]').value = '';
  document.querySelector('#addAccountForm input[name=password]').value = '';
  modal.classList.remove('modal-hidden');
  modal.style.display = 'flex';
}
function hideAddAccountModal() {
  const modal = document.getElementById('addAccountModal');
  if (!modal) return;
  modal.classList.add('modal-hidden');
  modal.style.display = 'none';
}
function setupAddAccountModal() {
  const cancel = document.getElementById('cancelAddAccount');
  if (cancel) cancel.onclick = (e) => { e.preventDefault(); hideAddAccountModal(); };
  const form = document.getElementById('addAccountForm');
  if (form) {
    form.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd.entries());
      const msgEl = document.getElementById('addAccountMsg');
      msgEl.style.color = '#d00';
      try {
        const r = await fetch('/api/add-account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await r.json();
        if (data.success) {
          msgEl.style.color = '#080';
          msgEl.innerText = `เพิ่มบัญชี ${data.username} สำเร็จ`;
          setTimeout(() => {
            hideAddAccountModal();
            location.reload();
          }, 700);
        } else {
          msgEl.innerText = data.msg || 'ไม่สำเร็จ';
        }
      } catch {
        msgEl.innerText = 'เกิดข้อผิดพลาดเครือข่าย';
      }
    };
  }
}

// helper to hide notification panel (used by avatar click)
function notifPanelHide() {
  // no-op placeholder for future
}

// เรียกใช้ในทุก HTML (หลังโหลด <body>)
window.onload = async function() {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  setupAddAccountModal();
  renderNav();
};