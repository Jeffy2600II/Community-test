// public/js/main.js
// Updated: mobile sidebar (slide-in from right) + robust header partial handling
// - Moves #navBar into the mobile sidebar when opened and moves it back when closed.
// - Gracefully retries header setup if partials aren't available yet.
// - Keeps dropdown/notification/account behaviors from original implementation.

// -------------------- Utilities --------------------
async function loadPartial(id, file) {
  try {
    const resp = await fetch(file);
    if (!resp.ok) throw new Error('partial fetch failed ' + resp.status);
    const html = await resp.text();
    const slot = document.getElementById(id);
    if (slot) slot.innerHTML = html;
    return true;
  } catch (e) {
    console.error('loadPartial error', e && e.message);
    return false;
  }
}

function elFrom(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstChild;
}

// -------------------- Globals --------------------
let globalAccounts = [];
let globalActive = null;
let dropdownEl = null;
let dropdownVisible = false;
let overlayEl = null;
let dropdownEscapeListener = null;

// -------------------- Header interactions (mobile sidebar) --------------------
function setupHeaderInteractions() {
  try {
    const toggle = document.getElementById('mobileMenuToggle');
    const headerBottom = document.getElementById('headerBottom');
    const mobileSidebar = document.getElementById('mobileSidebar');
    const mobileSidebarContent = document.getElementById('mobileSidebarContent');
    const mobileOverlay = document.getElementById('mobileSidebarOverlay');
    const navBar = document.getElementById('navBar');

    // If DOM nodes are not yet present (partials may not be loaded), retry once shortly.
    if (!toggle || !headerBottom || !mobileSidebar || !mobileSidebarContent || !mobileOverlay || !navBar) {
      setTimeout(() => {
        // try again once
        const retryToggle = document.getElementById('mobileMenuToggle');
        if (retryToggle) setupHeaderInteractions();
      }, 120);
      return;
    }

    // helpers for overlay accessibility
    function showMobileOverlay() {
      mobileOverlay.classList.remove('hidden');
      mobileOverlay.classList.add('show');
      mobileOverlay.setAttribute('aria-hidden', 'false');
    }
    function hideMobileOverlay() {
      mobileOverlay.classList.remove('show');
      mobileOverlay.setAttribute('aria-hidden', 'true');
      setTimeout(() => mobileOverlay.classList.add('hidden'), 320);
    }

    // Move navBar into sidebar content (preserve listeners)
    function moveNavToSidebar() {
      if (!mobileSidebarContent.contains(navBar)) {
        mobileSidebarContent.appendChild(navBar);
      }
    }
    // Move navBar back to headerBottom
    function moveNavToHeader() {
      if (!headerBottom.contains(navBar)) {
        headerBottom.appendChild(navBar);
      }
    }

    // track escape listener closure to remove later
    let escapeListener = null;

    function openSidebar() {
      mobileSidebar.classList.add('open');
      mobileSidebar.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      moveNavToSidebar();
      showMobileOverlay();
      // focus the content for keyboard users
      try { mobileSidebarContent.focus(); } catch (e) {}
      if (!escapeListener) {
        escapeListener = function (ev) {
          if (ev.key === 'Escape' && mobileSidebar.classList.contains('open')) {
            ev.preventDefault();
            closeSidebar();
          }
        };
        document.addEventListener('keydown', escapeListener, true);
      }
    }

    function closeSidebar() {
      mobileSidebar.classList.remove('open');
      mobileSidebar.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      hideMobileOverlay();
      // move nav back to header
      moveNavToHeader();
      if (escapeListener) {
        document.removeEventListener('keydown', escapeListener, true);
        escapeListener = null;
      }
      try { toggle.focus(); } catch (e) {}
    }

    // attach events
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = !mobileSidebar.classList.contains('open');
      if (willOpen) openSidebar(); else closeSidebar();
    });

    const btnClose = document.getElementById('mobileSidebarClose');
    if (btnClose) {
      btnClose.addEventListener('click', (ev) => {
        ev.preventDefault();
        closeSidebar();
      });
    }

    mobileOverlay.addEventListener('click', (ev) => {
      ev.preventDefault();
      closeSidebar();
    }, { passive: false });

    // ensure correct state on resize
    function headerResizeHandler() {
      const w = window.innerWidth;
      if (w > 800) {
        // desktop: ensure nav in header and toggle hidden
        moveNavToHeader();
        mobileSidebar.classList.remove('open');
        mobileSidebar.setAttribute('aria-hidden', 'true');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.style.display = 'none';
        mobileOverlay.classList.remove('show');
        mobileOverlay.classList.add('hidden');
      } else {
        toggle.style.display = '';
        // keep headerBottom collapsed by default on small screens
        headerBottom.classList.remove('open');
      }
    }
    headerResizeHandler();
    window.addEventListener('resize', headerResizeHandler);
  } catch (err) {
    console.error('setupHeaderInteractions error:', err && err.message);
  }
}

// -------------------- Fetch helpers --------------------
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

// -------------------- Dropdown + Overlay --------------------
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
  dropdownEscapeListener = function (ev) {
    if (ev.key === 'Escape' && dropdownVisible) {
      ev.preventDefault();
      hideDropdown();
    }
  };
  document.addEventListener('keydown', dropdownEscapeListener, true);
}

function hideOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) overlayEl.remove();
  if (dropdownEscapeListener) {
    document.removeEventListener('keydown', dropdownEscapeListener, true);
    dropdownEscapeListener = null;
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

// -------------------- Notification helpers --------------------
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

// -------------------- Positioning --------------------
async function positionDropdownRelativeTo(anchorEl) {
  const dd = ensureDropdown();
  const winW = window.innerWidth;
  if (winW <= 720) {
    dd.style.width = '100%';
    dd.style.left = '0px';
    dd.style.right = '';
    const top = (document.querySelector('.site-header')?.getBoundingClientRect().bottom || 68) + window.scrollY;
    dd.style.top = (top + 8) + 'px';
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

// -------------------- Nav rendering --------------------
async function renderNav() {
  const nav = document.getElementById('navBar');
  if (!nav) {
    // navBar might not exist yet (partial not loaded) — retry shortly
    setTimeout(renderNav, 120);
    return;
  }
  nav.innerHTML = '';

  // Left-side links
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

  // Notification bell (simple SVG)
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.setAttribute('role','button');
  bell.setAttribute('aria-label','Notifications');
  bell.style.cursor = 'pointer';
  bell.style.position = 'relative';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#97a0b3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 17H9"/><path d="M12 3v1"/><path d="M5 9a7 7 0 0014 0"/></svg>`;

  // badge count calculation
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

  // Account area
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
    // safe HTML: escaped values where appropriate (displayName may contain characters)
    const safeName = (activeAcc.displayName || activeAcc.username).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="${activeAcc.username}" style="width:32px;height:32px;border-radius:8px;object-fit:cover"> <span style="color:#1f2a37;font-weight:700">${safeName}</span>`;
    accountArea.appendChild(avatarBtn);

    const dd = ensureDropdown();
    dd.innerHTML = '';

    avatarBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      dd.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.innerHTML = `<img src="${avatarUrl}" class="avatar-img" style="width:48px;height:48px;border-radius:8px;object-fit:cover"><div style="flex:1"><div style="font-weight:700">${safeName}</div><div class="small" style="color:var(--muted)">@${activeAcc.username}</div></div>`;
      dd.appendChild(header);

      const list = document.createElement('div');
      list.className = 'dropdown-list';
      list.style.padding = '8px';
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '8px';

      // other saved accounts (if any)
      for (let acc of globalAccounts) {
        if (acc.username === globalActive) continue;
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        const safeDisp = (acc.displayName || acc.username).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
        item.innerHTML = `<img src="${acc.profilePic || '/img/default_profile.png'}" class="avatar-img" style="width:36px;height:36px;border-radius:6px;object-fit:cover"><div style="flex:1"><div style="font-weight:700">${safeDisp}</div><div class="small" style="color:var(--muted)">@${acc.username}</div></div>`;
        item.addEventListener('click', async () => {
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
        });
        list.appendChild(item);
      }

      dd.appendChild(list);

      const footer = document.createElement('div');
      footer.style.padding = '8px';
      footer.style.borderTop = '1px solid rgba(15,23,42,0.04)';
      footer.style.display = 'flex';
      footer.style.justifyContent = 'space-between';
      footer.innerHTML = `<div><a href="/accounts">จัดการบัญชี</a></div><div><a href="/login?add=1" class="small">เพิ่มบัญชี</a></div>`;
      dd.appendChild(footer);

      await positionDropdownRelativeTo(avatarBtn);
      showDropdown();
    });

    // Notification bell click: show recent notifications inside dropdown
    bell.addEventListener('click', async (ev) => {
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
          it.addEventListener('click', async () => {
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
          });
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
        mar.addEventListener('click', async (ev) => {
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
        });
      }
    });

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

// -------------------- Events --------------------
function setupGlobalRefreshOnMessage() {
  window.addEventListener('accountsChanged', async () => {
    await renderNav();
  });
}

// -------------------- Init --------------------
window.onload = async function() {
  try {
    // Load header/footer partials if available. Continue even if they fail.
    await loadPartial('headerSlot', '/partial/header.html').catch(()=>{});
    await loadPartial('footerSlot', '/partial/footer.html').catch(()=>{});

    // Setup header interactions (will retry internally if partial wasn't ready)
    setupHeaderInteractions();
    setupGlobalRefreshOnMessage();
    // Render nav (renderNav is resilient and will retry if #navBar not present yet)
    await renderNav();
  } catch (e) {
    console.error('main init error', e && e.message);
  }
};