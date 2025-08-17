// โหลด partial (header/footer) ด้วย fetch แล้วแทรก
async function loadPartial(id, file) {
  const resp = await fetch(file);
  const html = await resp.text();
  document.getElementById(id).innerHTML = html;
}

// Render Navbar (แบบ dynamic, ตาม session)
async function renderNav() {
  let html = `<a href="/">หน้าแรก</a>`;
  try {
    const me = await fetch('/api/profile');
    if (me.ok) {
      const { profile } = await me.json();
      html += `
        <a href="/post/create">สร้างโพสต์</a>
        <a href="/user/${encodeURIComponent(profile.username)}">${profile.displayName || profile.username}</a>
        <a href="/profile/edit">ตั้งค่า</a>
        <a href="#" id="switchAccountBtn">สลับบัญชี</a>
        <a href="#" id="logoutBtn">ออกจากระบบ</a>
      `;
    } else {
      html += `
        <a href="/login">เข้าสู่ระบบ</a>
        <a href="/register">สมัครสมาชิก</a>
      `;
    }
  } catch {
    html += `
      <a href="/login">เข้าสู่ระบบ</a>
      <a href="/register">สมัครสมาชิก</a>
    `;
  }
  document.getElementById('navBar').innerHTML = html;
  // ... (add logic for switch/logout asเดิม)
}

// เรียกใช้ในทุก HTML (หลังโหลด <body>)
window.onload = async function() {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  renderNav();
}