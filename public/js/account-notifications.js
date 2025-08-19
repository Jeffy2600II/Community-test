// public/js/account-notifications.js
// Enhances the account-management notifications list:
// - Fetches /api/notifications and renders clickable items
// - Click => POST /api/notifications/mark-read { ids: [id] } then navigate to related URL
// - Supports "Mark all read" and incremental UI updates (optimistic)
// - Best-effort compute URL from notification.meta (supports meta.url, postId, commentId, actorUsername)

(function () {
  // container id expected on the account-management page
  const CONTAINER_ID = 'accountNotifications';

  // Utility: fetch JSON safely
  async function fetchJson(url, opts) {
    try {
      const r = await fetch(url, opts);
      const tx = await r.text();
      try { return JSON.parse(tx); } catch { return null; }
    } catch (err) {
      console.warn('fetchJson error', err && err.message);
      return null;
    }
  }

  // Compute destination URL from notification object (same logic as nav)
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

  // Render timestamp in readable form
  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch { return iso || ''; }
  }

  // Render single notification element
  function renderNotificationItem(n) {
    const row = document.createElement('div');
    row.className = 'notif-row';
    row.dataset.notifId = n.id || '';
    row.style.padding = '12px';
    row.style.borderBottom = '1px solid rgba(0,0,0,0.04)';
    row.style.cursor = 'pointer';
    row.style.display = 'flex';
    row.style.flexDirection = 'column';
    row.style.gap = '6px';
    if (!n.read) row.style.background = '#fffef6';

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.justifyContent = 'space-between';
    top.innerHTML = `<div style="font-weight:700">${escapeHtml(n.type || 'การแจ้งเตือน')}</div><div class="small">${fmtDate(n.createdAt)}</div>`;

    const msg = document.createElement('div');
    msg.className = 'small';
    msg.textContent = n.message || '';

    row.appendChild(top);
    row.appendChild(msg);

    // click behavior: mark-read single then navigate
    row.addEventListener('click', async function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      // optimistic UI
      row.style.background = '#ffffff';
      // mark read on server (single id)
      try {
        await fetch('/api/notifications/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [n.id] })
        });
      } catch (err) {
        console.warn('mark-read failed', err && err.message);
      }

      // update UI: set read flag
      row.dataset.read = '1';

      // compute dest and navigate
      const dest = computeNotificationUrl(n);
      if (dest) {
        // small delay to allow server to process mark-read (optional)
        setTimeout(() => { location.assign(dest); }, 80);
      } else {
        // no destination: optionally open a detail view or just refresh list
        // we simply refresh the list
        await loadAndRender();
      }
    }, { passive: true });

    return row;
  }

  // Escape helper for displaying types safely (simple)
  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]);
    });
  }

  // Render container contents: header, list, footer
  async function renderContainer(container, data) {
    container.innerHTML = ''; // clear

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.padding = '8px 12px';
    header.innerHTML = `<div><strong>การแจ้งเตือนของฉัน</strong><div class="small">${data.unread || 0} ยังไม่อ่าน</div></div>`;

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '8px';
    const markAllBtn = document.createElement('button');
    markAllBtn.className = 'btn btn-ghost';
    markAllBtn.textContent = 'ทำเครื่องหมายว่าอ่านทั้งหมด';
    markAllBtn.addEventListener('click', async function (ev) {
      ev.preventDefault();
      markAllBtn.disabled = true;
      try {
        await fetch('/api/notifications/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      } catch (err) {
        console.warn('mark all read failed', err && err.message);
      } finally {
        await loadAndRender();
      }
    }, { passive: false });
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-ghost';
    refreshBtn.textContent = 'รีเฟรช';
    refreshBtn.addEventListener('click', async function () {
      await loadAndRender();
    }, { passive: true });

    controls.appendChild(markAllBtn);
    controls.appendChild(refreshBtn);
    header.appendChild(controls);

    container.appendChild(header);

    const list = document.createElement('div');
    list.id = 'accountNotifList';
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.borderTop = '1px solid rgba(0,0,0,0.03)';

    const items = (data.notifications || []).filter(n => true); // optionally filter by active user
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'small';
      empty.style.padding = '18px';
      empty.textContent = 'ยังไม่มีการแจ้งเตือน';
      list.appendChild(empty);
    } else {
      for (let n of items) {
        const el = renderNotificationItem(n);
        list.appendChild(el);
      }
    }

    container.appendChild(list);

    // pagination or show more could be added here
  }

  // load notifications then render
  async function loadAndRender() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) {
      console.warn('Container not found:', CONTAINER_ID);
      return;
    }
    const data = await fetchJson('/api/notifications');
    if (!data) {
      container.innerHTML = '<div class="small" style="padding:12px">ไม่สามารถโหลดการแจ้งเตือนได้ขณะนี้</div>';
      return;
    }
    // If server returns notifications array under data.notifications, use it.
    await renderContainer(container, data);
  }

  // Expose manual refresh API (optional)
  window.accountNotifications = {
    refresh: loadAndRender
  };

  // Auto init when DOM ready (or call window.accountNotifications.refresh() manually)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAndRender);
  } else {
    setTimeout(loadAndRender, 0);
  }
})();