// public/js/main.js (robust version: safer partial loading, wait-for-header, guarded interactions)
//
// Changes:
// - loadPartial now checks response.ok and falls back to simple header HTML if fetch fails.
// - setupHeaderInteractions is async and uses waitForElement to ensure header DOM exists.
// - wrapped risky sections in try/catch so one error doesn't break the rest of the script.
// - window.onload awaits partials and header setup before calling renderNav().

(function () {
  /* -------------------- Utilities -------------------- */
  async function loadPartial(id, file) {
    try {
      const resp = await fetch(file);
      if (!resp.ok) throw new Error('partial fetch failed: ' + resp.status);
      const html = await resp.text();
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
      else console.warn('loadPartial: missing container #' + id);
      return true;
    } catch (e) {
      console.warn('loadPartial error for', file, e && e.message);
      // fallback: if header failed to load, insert a minimal header so JS that expects it works
      if (id === 'headerSlot') {
        const fallback = `
<header class="site-header" role="banner">
  <div class="container header-inner">
    <div class="header-top" role="presentation">
      <a class="logo" href="/" aria-label="COMMUNITY home">
        <div class="brand">COMMUNITY</div>
      </a>
      <button id="mobileMenuToggle" class="btn btn-icon" aria-expanded="false" aria-controls="headerBottom" aria-label="Toggle menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1f2a37" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
      </button>
    </div>
    <div id="headerBottom" class="header-bottom" role="navigation" aria-label="Site actions">
      <div class="header-search" role="search" aria-label="Site search">
        <form onsubmit="event.preventDefault(); const q=this.query.value.trim(); if(q) location.href='/search?q='+encodeURIComponent(q);">
          <input type="search" name="query" placeholder="ค้นหา" aria-label="ค้นหา">
        </form>
      </div>
      <div id="navBar" class="header-actions" aria-hidden="false"></div>
    </div>
  </div>
</header>`;
        const container = document.getElementById(id);
        if (container) container.innerHTML = fallback;
        else console.error('Cannot insert fallback header: missing container #' + id);
        return false;
      }
      return false;
    }
  }

  function elFrom(html) {
    const div = document.createElement('div');
    div.innerHTML = html.trim();
    return div.firstChild;
  }

  // wait for an element to appear in DOM (useful for partial injection)
  function waitForElement(selector, timeout = 2500) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver((mutations, observer) => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
      // fallback timeout
      setTimeout(() => {
        resolve(document.querySelector(selector)); // may be null
        obs.disconnect();
      }, timeout);
    });
  }

  /* -------------------- Globals -------------------- */
  let globalAccounts = [];
  let globalActive = null;
  let dropdownEl = null;
  let dropdownVisible = false;
  let overlayEl = null;
  let escapeKeyListener = null;

  /* -------------------- Header interactions (mobile + sidebar) -------------------- */
  async function setupHeaderInteractions() {
    try {
      // ensure header exists (partial may have been loaded async)
      await waitForElement('.site-header', 3000);
      const headerTop = document.querySelector('.header-top');
      const toggle = document.getElementById('mobileMenuToggle');
      const headerBottom = document.getElementById('headerBottom');
      if (!headerBottom) {
        console.warn('setupHeaderInteractions: headerBottom not found; skipping header toggle setup');
      } else {
        // Safe: only attach if toggle exists; some fallbacks may not create it
        if (toggle) {
          toggle.addEventListener('click', (ev) => {
            try {
              ev.stopPropagation();
              const isOpen = headerBottom.classList.toggle('open');
              toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
              if (isOpen) hideDropdown();
            } catch (e) { console.warn('mobileMenuToggle handler error', e && e.message); }
          });
        }

        // close headerBottom if clicked outside (mobile)
        document.addEventListener('click', (ev) => {
          try {
            if (!headerBottom.classList.contains('open')) return;
            const path = ev.composedPath ? ev.composedPath() : (ev.path || []);
            if (!path || path.length === 0) return;
            if (!path.includes(headerBottom) && !path.includes(toggle)) {
              headerBottom.classList.remove('open');
              if (toggle) toggle.setAttribute('aria-expanded', 'false');
            }
          } catch (e) { /* swallow */ }
        }, true);

        // ensure headerBottom state on resize
        function headerResizeHandler() {
          try {
            const w = window.innerWidth;
            if (w > 800) {
              headerBottom.classList.add('open');
              if (toggle) { toggle.setAttribute('aria-expanded', 'true'); toggle.style.display = 'none'; }
            } else {
              headerBottom.classList.remove('open');
              if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.style.display = ''; }
            }
          } catch (e) { console.warn('headerResizeHandler error', e && e.message); }
        }
        window.addEventListener('resize', headerResizeHandler);
        headerResizeHandler();
      }

      // Sidebar (off-canvas) support: only if there's a .profile-hero (or other element you treat as sidebar)
      try {
        const sidebarEl = document.querySelector('.profile-hero');
        if (sidebarEl && headerTop) {
          // ensure an id for aria-controls
          if (!sidebarEl.id) sidebarEl.id = 'siteSidebar';

          // create sidebar toggle if not present
          let sidebarToggle = document.getElementById('mobileSidebarToggle');
          if (!sidebarToggle) {
            sidebarToggle = document.createElement('button');
            sidebarToggle.id = 'mobileSidebarToggle';
            sidebarToggle.className = 'btn btn-icon';
            sidebarToggle.type = 'button';
            sidebarToggle.setAttribute('aria-controls', sidebarEl.id);
            sidebarToggle.setAttribute('aria-expanded', 'false');
            sidebarToggle.setAttribute('aria-label', 'Toggle sidebar');
            sidebarToggle.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1f2a37" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"></path></svg>`;
            // place it in headerTop (append to right side)
            headerTop.appendChild(sidebarToggle);
          }

          function ensureSidebarOverlay() {
            let ov = document.querySelector('.sidebar-overlay');
            if (!ov) {
              ov = document.createElement('div');
              ov.className = 'sidebar-overlay';
              ov.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation(); closeSidebar();
              }, { passive: true });
              document.body.appendChild(ov);
            }
            return ov;
          }

          function openSidebar() {
            document.body.classList.add('sidebar-open');
            ensureSidebarOverlay();
            sidebarToggle.setAttribute('aria-expanded', 'true');
            // prevent background scroll
            document.documentElement.style.overflow = 'hidden';
            hideDropdown();
          }
          function closeSidebar() {
            document.body.classList.remove('sidebar-open');
            const ov = document.querySelector('.sidebar-overlay');
            if (ov) ov.remove();
            if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', 'false');
            document.documentElement.style.overflow = '';
          }

          sidebarToggle.addEventListener('click', function (ev) {
            try {
              ev.stopPropagation();
              const isOpen = document.body.classList.toggle('sidebar-open');
              sidebarToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
              if (isOpen) {
                ensureSidebarOverlay();
                document.documentElement.style.overflow = 'hidden';
                hideDropdown();
              } else {
                const ov = document.querySelector('.sidebar-overlay');
                if (ov) ov.remove();
                document.documentElement.style.overflow = '';
              }
            } catch (e) { console.warn('sidebarToggle click error', e && e.message); }
          });

          // close sidebar on outside click / escape
          document.addEventListener('click', (ev) => {
            try {
              if (!document.body.classList.contains('sidebar-open')) return;
              const path = ev.composedPath ? ev.composedPath() : (ev.path || []);
              if (!path || path.length === 0) return;
              if (!path.includes(sidebarEl) && !path.includes(sidebarToggle)) {
                closeSidebar();
              }
            } catch (e) {}
          }, true);

          document.addEventListener('keydown', (ev) => {
            try {
              if (ev.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
                closeSidebar();
              }
            } catch (e) {}
          }, true);

          // ensure sidebar state on resize
          function sidebarResizeHandler() {
            try {
              const w = window.innerWidth;
              if (w > 800) {
                document.body.classList.remove('sidebar-open');
                const ov = document.querySelector('.sidebar-overlay');
                if (ov) ov.remove();
                document.documentElement.style.overflow = '';
                if (sidebarToggle) sidebarToggle.style.display = 'none';
              } else {
                if (sidebarToggle) sidebarToggle.style.display = '';
              }
            } catch (e) {}
          }
          window.addEventListener('resize', sidebarResizeHandler);
          sidebarResizeHandler();
        } // end if sidebarEl && headerTop
      } catch (e) { console.warn('sidebar setup failed', e && e.message); }
    } catch (err) {
      console.error('setupHeaderInteractions error', err && err.message);
    }
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

  /* -------------------- Dropdown + Overlay helpers (unchanged) -------------------- */
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

  /* -------------------- Nav rendering (kept compatible) -------------------- */
  async function renderNav() {
    try {
      const nav = document.getElementById('navBar');
      if (!nav) { console.warn('renderNav: #navBar not found'); return; }
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
        const filtered = (notifData.notifications || []).filter(n => {
          try { return isNotificationFromActive(n, activeName); } catch(e){ return true; }
        });
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

      // accounts / avatar (similar to earlier)
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
        avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="${activeAcc.username}" style="width:32px;height:32px;border-radius:8px;object-fit:cover"> <span style="color:#1f2a37;font-weight:700">${activeAcc.username}</span>`;
        accountArea.appendChild(avatarBtn);

        // dropdown logic (kept similar)...
        const dd = ensureDropdown();
        dd.innerHTML = '';

        avatarBtn.onclick = async (ev) => {
          ev.stopPropagation();
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

        // notification bell handler (kept)
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
    } catch (e) {
      console.error('renderNav error', e && e.message);
    }
  }

  /* -------------------- Misc helpers copied from previous file (computeNotificationUrl etc.) -------------------- */
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

  async function positionDropdownRelativeTo(anchorEl) {
    try {
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
    } catch (e) { /* ignore positioning errors */ }
  }

  function setupGlobalRefreshOnMessage() {
    window.addEventListener('accountsChanged', async () => {
      await renderNav();
    });
  }

  /* -------------------- Init -------------------- */
  window.addEventListener('load', async function () {
    try {
      await loadPartial('headerSlot', '/partial/header.html').catch(()=>{});
      await loadPartial('footerSlot', '/partial/footer.html').catch(()=>{});
      await setupHeaderInteractions();
      setupGlobalRefreshOnMessage();
      await renderNav();
    } catch (e) {
      console.error('main init failed', e && e.message);
    }
  });

  // expose for debugging
  window.__community_debug = {
    loadPartial, setupHeaderInteractions, renderNav
  };

})();