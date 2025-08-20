// public/js/account-notifications.js
// สำหรับหน้า accounts (จัดการบัญชี): แสดงรายการแจ้งเตือนแบบใหม่
// - คลิกที่แจ้งเตือนจะ mark-read และนำทางไปยังโพสต์/ยูสเซอร์ที่เกี่ยวข้อง
// - รองรับปุ่ม "อ่านทั้งหมด" และรีเฟรช

(function () {
  const CONTAINER_ID = "accountNotifications";

  // สร้าง URL สำหรับการนำทางจาก notification.meta
  function computeNotificationUrl(n) {
    if (!n || !n.meta) return null;
    const m = n.meta;
    if (m.url) return m.url;
    if (m.postId) return `/post/${encodeURIComponent(m.postId)}`;
    if (m.commentId && m.postId) return `/post/${encodeURIComponent(m.postId)}#comment-${encodeURIComponent(m.commentId)}`;
    if (m.actorUsername) return `/user/${encodeURIComponent(m.actorUsername)}`;
    if (m.username) return `/user/${encodeURIComponent(m.username)}`;
    if (m.item && m.item.type === "post" && m.item.id) return `/post/${encodeURIComponent(m.item.id)}`;
    return null;
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString(); }
    catch { return iso || ""; }
  }

  function escapeHtml(s) {
    if (!s) return "";
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m]);
    });
  }

  // แสดงแจ้งเตือนทีละรายการ
  function renderNotificationItem(n) {
    const row = document.createElement("div");
    row.className = "notif-row";
    row.dataset.notifId = n.id || "";
    row.style.padding = "12px";
    row.style.borderBottom = "1px solid rgba(0,0,0,0.04)";
    row.style.cursor = "pointer";
    row.style.display = "flex";
    row.style.flexDirection = "column";
    row.style.gap = "6px";
    if (!n.read) row.style.background = "#fffef6";

    const top = document.createElement("div");
    top.style.display = "flex";
    top.style.justifyContent = "space-between";
    top.innerHTML =
      `<div style="font-weight:700">${escapeHtml(n.type || "การแจ้งเตือน")}</div><div class="small">${fmtDate(n.createdAt)}</div>`;

    const msg = document.createElement("div");
    msg.className = "small";
    msg.textContent = n.message || "";

    row.appendChild(top);
    row.appendChild(msg);

    // คลิก -> mark-read + navigate
    row.addEventListener("click", async function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      row.style.background = "#ffffff";
      try {
        await fetch("/api/notifications/mark-read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [n.id] })
        });
      } catch (err) {
        // เงียบ
      }
      row.dataset.read = "1";
      const dest = computeNotificationUrl(n);
      if (dest) setTimeout(() => { location.assign(dest); }, 80);
      else await loadAndRender();
    }, { passive: true });

    return row;
  }

  // render list ทั้งหมด
  async function renderContainer(container, data) {
    container.innerHTML = "";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.padding = "8px 12px";
    header.innerHTML =
      `<div><strong>การแจ้งเตือนของฉัน</strong><div class="small">${data.unread || 0} ยังไม่อ่าน</div></div>`;

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "8px";
    const markAllBtn = document.createElement("button");
    markAllBtn.className = "btn btn-ghost";
    markAllBtn.textContent = "ทำเครื่องหมายว่าอ่านทั้งหมด";
    markAllBtn.addEventListener("click", async function (ev) {
      ev.preventDefault();
      markAllBtn.disabled = true;
      try {
        await fetch("/api/notifications/mark-read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
      } catch (err) {}
      await loadAndRender();
    }, { passive: false });
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "btn btn-ghost";
    refreshBtn.textContent = "รีเฟรช";
    refreshBtn.addEventListener("click", async function () {
      await loadAndRender();
    }, { passive: true });

    controls.appendChild(markAllBtn);
    controls.appendChild(refreshBtn);
    header.appendChild(controls);

    container.appendChild(header);

    const list = document.createElement("div");
    list.id = "accountNotifList";
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.borderTop = "1px solid rgba(0,0,0,0.03)";

    const items = (data.notifications || []);
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "small";
      empty.style.padding = "18px";
      empty.textContent = "ยังไม่มีการแจ้งเตือน";
      list.appendChild(empty);
    } else {
      for (let n of items) {
        const el = renderNotificationItem(n);
        list.appendChild(el);
      }
    }
    container.appendChild(list);
  }

  async function fetchJson(url, opts) {
    try {
      const r = await fetch(url, opts);
      const tx = await r.text();
      try { return JSON.parse(tx); } catch { return null; }
    } catch (err) { return null; }
  }

  // โหลดข้อมูล + render
  async function loadAndRender() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    const data = await fetchJson("/api/notifications");
    if (!data) {
      container.innerHTML = '<div class="small" style="padding:12px">ไม่สามารถโหลดการแจ้งเตือนได้ขณะนี้</div>';
      return;
    }
    await renderContainer(container, data);
  }

  // expose manual refresh (ถ้าต้องเรียกจาก script อื่น)
  window.accountNotifications = {
    refresh: loadAndRender
  };

  // auto init
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadAndRender);
  } else {
    setTimeout(loadAndRender, 0);
  }
})();