// โหลด partial (header/footer) ด้วย fetch แล้วแทรก
async function loadPartial(id, file) {
  const resp = await fetch(file);
  const html = await resp.text();
  document.getElementById(id).innerHTML = html;
}

// Render Navbar (แบบ dynamic, ตาม session) — ใช้ /api/accounts เพื่อแสดงรายการบัญชีที่บันทึกไว้
async function renderNav() {
  let html = `<a href="/">หน้าแรก</a>`;
  let profile = null;
  let accountsData = null;
  try {
    const accResp = await fetch('/api/accounts');
    if (accResp.ok) {
      const accJson = await accResp.json();
      if (accJson && accJson.success) accountsData = accJson;
    }
  } catch {}

  if (accountsData && accountsData.accounts && accountsData.accounts.length > 0) {
    // กรณีมีบัญชีบันทึกไว้
    html += `<a href="/post/create">สร้างโพสต์</a>`;
    // แสดง dropdown ของบัญชีที่บันทึกไว้ (simple)
    html += `<span style="color:#fff; margin-left:1em;">บัญชี: </span>`;
    html += `<select id="accountSelect" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.2);">`;
    for (let acc of accountsData.accounts) {
      const sel = (accountsData.active === acc.username) ? 'selected' : '';
      html += `<option value="${encodeURIComponent(acc.username)}" ${sel}>${acc.displayName || acc.username}</option>`;
    }
    html += `</select>`;
    html += `<a href="#" id="addAccountBtn">เพิ่มบัญชี</a>`;
    html += `<a href="#" id="removeAccountBtn">ลบบัญชี</a>`;
    html += `<a href="#" id="logoutBtn" style="margin-left:1em;">ออกจากระบบ</a>`;
  } else {
    // ไม่มีบัญชีบันทึกไว้ -> แสดงลิงก์เข้าสู่ระบบ/สมัครแบบเดิม
    html += `
      <a href="/login">เข้าสู่ระบบ</a>
      <a href="/register">สมัครสมาชิก</a>
    `;
  }

  document.getElementById('navBar').innerHTML = html;

  // Event handlers
  const addBtn = document.getElementById('addAccountBtn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showAddAccountModal();
    });
  }

  const accountSelect = document.getElementById('accountSelect');
  if (accountSelect) {
    accountSelect.addEventListener('change', async (e) => {
      const username = decodeURIComponent(e.target.value);
      if (!confirm(`สลับไปใช้บัญชี ${username} ?`)) {
        // reset select to active by refetching
        renderNav();
        return;
      }
      try {
        const r = await fetch('/api/accounts/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username })
        });
        const data = await r.json();
        if (data.success) location.reload();
        else alert(data.msg || 'ไม่สามารถสลับบัญชีได้');
      } catch (err) {
        alert('เกิดข้อผิดพลาดเครือข่าย');
      }
    });
  }

  const removeBtn = document.getElementById('removeAccountBtn');
  if (removeBtn) {
    removeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const sel = document.getElementById('accountSelect');
      if (!sel) return alert('ไม่พบบัญชีที่จะลบ');
      const username = decodeURIComponent(sel.value);
      if (!confirm(`ลบบัญชี ${username} ออกจากรายการ?`)) return;
      try {
        const r = await fetch('/api/accounts/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username })
        });
        const data = await r.json();
        if (data.success) location.reload();
        else alert(data.msg || 'ลบไม่สำเร็จ');
      } catch {
        alert('เกิดข้อผิดพลาดเครือข่าย');
      }
    });
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('ยืนยันออกจากระบบ (จะยังคงเก็บบัญชีไว้ในรายการ) ?')) return;
      try {
        const r = await fetch('/api/logout', { method: 'POST' });
        if (r.ok) {
          location.reload();
        } else {
          alert('ไม่สามารถออกจากระบบได้ในขณะนี้');
        }
      } catch (err) {
        alert('เกิดข้อผิดพลาดเครือข่าย');
      }
    });
  }

  setupAddAccountModal();
}

// Modal: add account
function showAddAccountModal() {
  const modal = document.getElementById('addAccountModal');
  if (!modal) return alert('ไม่พบ UI สำหรับเพิ่มบัญชี');
  document.getElementById('addAccountMsg').innerText = '';
  document.querySelector('#addAccountForm input[name=email]').value = '';
  document.querySelector('#addAccountForm input[name=password]').value = '';
  modal.style.display = 'flex';
}
function hideAddAccountModal() {
  const modal = document.getElementById('addAccountModal');
  if (!modal) return;
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

// เรียกใช้ในทุก HTML (หลังโหลด <body>)
window.onload = async function() {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  renderNav();
}