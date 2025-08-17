// โหลด partial (header/footer) ด้วย fetch แล้วแทรก
async function loadPartial(id, file) {
  const resp = await fetch(file);
  const html = await resp.text();
  document.getElementById(id).innerHTML = html;
}

// Render Navbar (แบบ dynamic, ตาม session)
async function renderNav() {
  let html = `<a href="/">หน้าแรก</a>`;
  let profile = null;
  try {
    const meResp = await fetch('/api/profile');
    const ct = (meResp.headers.get('content-type') || '');
    if (ct.includes('application/json')) {
      const meJson = await meResp.json();
      if (meJson && meJson.success) profile = meJson.profile;
    } else {
      // ถ้าไม่ใช่ JSON (เช่น redirect ไปหน้า login) ให้ถือว่าไม่ได้ล็อกอิน
      profile = null;
    }
  } catch (err) {
    profile = null;
  }

  if (profile) {
    const disp = encodeURIComponent(profile.username);
    html += `
      <a href="/post/create">สร้างโพสต์</a>
      <a href="/user/${disp}">${profile.displayName || profile.username}</a>
      <a href="/profile/edit">ตั้งค่า</a>
      <a href="#" id="switchAccountBtn">สลับบัญชี</a>
      <a href="#" id="logoutBtn">ออกจากระบบ</a>
      <span style="margin-left:1em;color:#fff;opacity:.9">(${profile.username})</span>
    `;
  } else {
    html += `
      <a href="/login">เข้าสู่ระบบ</a>
      <a href="/register">สมัครสมาชิก</a>
    `;
  }

  document.getElementById('navBar').innerHTML = html;

  // เพิ่ม logic ให้ปุ่มต่างๆ
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('ยืนยันออกจากระบบ?')) return;
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

  const switchBtn = document.getElementById('switchAccountBtn');
  if (switchBtn) {
    switchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showSwitchModal();
    });
  }

  // ตั้งค่าปุ่มใน modal
  setupSwitchModal();
}

// แสดง/ซ่อน modal สลับบัญชี
function showSwitchModal() {
  const modal = document.getElementById('switchAccountModal');
  if (!modal) return alert('ไม่พบ UI สำหรับสลับบัญชี');
  document.getElementById('switchTokenInput').value = '';
  document.getElementById('switchMsg').innerText = '';
  modal.style.display = 'flex';
}
function hideSwitchModal() {
  const modal = document.getElementById('switchAccountModal');
  if (!modal) return;
  modal.style.display = 'none';
}
function setupSwitchModal() {
  const cancel = document.getElementById('cancelSwitchBtn');
  const confirmBtn = document.getElementById('confirmSwitchBtn');
  if (cancel) cancel.onclick = (e) => { e.preventDefault(); hideSwitchModal(); };
  if (confirmBtn) confirmBtn.onclick = async (e) => {
    e.preventDefault();
    const token = document.getElementById('switchTokenInput').value.trim();
    const msgEl = document.getElementById('switchMsg');
    msgEl.style.color = '#d00';
    if (!token) { msgEl.innerText = 'กรุณาใส่โทเคนก่อน'; return; }
    try {
      const res = await fetch('/api/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (data.success) {
        msgEl.style.color = '#080';
        msgEl.innerText = 'สลับบัญชีสำเร็จ กำลังโหลดใหม่...';
        setTimeout(() => location.reload(), 800);
      } else {
        msgEl.innerText = data.msg || 'สลับบัญชีไม่สำเร็จ';
      }
    } catch (err) {
      msgEl.innerText = 'เกิดข้อผิดพลาดเครือข่าย';
    }
  };
}

// เรียกใช้ในทุก HTML (หลังโหลด <body>)
window.onload = async function() {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  renderNav();
}