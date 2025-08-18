// public/js/main.js
// Header partial loader + account dropdown + secure IndexedDB metadata store
// - Stores only non-sensitive metadata (username, displayName, profilePic, addedAt, lastUsedAt, order)
// - Optional encryption of metadata with passphrase (PBKDF2 -> AES-GCM)
// - Uses IndexedDB for persistent storage (better than localStorage)
// - BroadcastChannel (with storage fallback) syncs tabs
// - Dropdown opens immediately and uses pointerdown capture guard to prevent underlying activation

/* ===========================
   Config / constants
   =========================== */
const LS_MIGRATE_KEY = 'COMMUNITY_ACCOUNTS_V1'; // used only if migrating from old localStorage
const IDB_NAME = 'community-store';
const IDB_VERSION = 1;
const IDB_STORE = 'meta';
const BC_CHANNEL = 'community:accounts';
const PROTECTION_META_KEY = 'protected'; // stored inside the meta object to indicate protection
const PBKDF2_ITER = 150_000; // iteration count (reasonable - adjust by performance)
const PBKDF2_SALT_BYTES = 16;
const AES_KEY_LENGTH = 256; // bits
const AES_IV_BYTES = 12;

/* ===========================
   IndexedDB helpers
   =========================== */
function openIDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, IDB_VERSION);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const st = tx.objectStore(IDB_STORE);
    const rq = st.get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function idbSet(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const st = tx.objectStore(IDB_STORE);
    const rq = st.put(value, key);
    rq.onsuccess = () => resolve(true);
    rq.onerror = () => reject(rq.error);
  });
}

async function idbDelete(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const st = tx.objectStore(IDB_STORE);
    const rq = st.delete(key);
    rq.onsuccess = () => resolve(true);
    rq.onerror = () => reject(rq.error);
  });
}

/* ===========================
   Crypto helpers (PBKDF2 + AES-GCM)
   =========================== */
function bufToBase64(b) {
  return btoa(String.fromCharCode(...new Uint8Array(b)));
}
function base64ToBuf(s) {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
function strToBuf(s) {
  return new TextEncoder().encode(s);
}
function bufToStr(b) {
  return new TextDecoder().decode(b);
}

async function deriveKeyFromPassword(passphrase, saltBase64) {
  const salt = base64ToBuf(saltBase64);
  const passKey = await crypto.subtle.importKey(
    'raw',
    strToBuf(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const derived = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    passKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
  return derived;
}

async function genSaltBase64() {
  const buf = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  return bufToBase64(buf.buffer);
}

async function encryptJSONWithKey(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const plaintext = strToBuf(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: bufToBase64(iv.buffer), cipher: bufToBase64(cipher) };
}

async function decryptJSONWithKey({ iv, cipher }, key) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(iv) }, key, base64ToBuf(cipher));
    return JSON.parse(bufToStr(pt));
  } catch (e) {
    throw new Error('decrypt_failed');
  }
}

/* ===========================
   Storage API: encrypted or plaintext in IndexedDB
   - meta record shape:
     { protected: boolean, salt?: string, data?: { iv, cipher } }  // encrypted
     or
     { protected: false, accounts: [...], active: 'username' }    // plaintext
   =========================== */

async function loadLocalMeta() {
  // Try to read from IDB
  try {
    const rec = await idbGet('meta');
    if (!rec) {
      // migration: check localStorage old key and migrate
      const raw = localStorage.getItem(LS_MIGRATE_KEY);
      if (raw) {
        try {
          const fallback = JSON.parse(raw);
          // store plaintext in IDB (no protection)
          const newRec = { protected: false, accounts: fallback.accounts || [], active: fallback.active || null };
          await idbSet('meta', newRec);
          localStorage.removeItem(LS_MIGRATE_KEY);
          return newRec;
        } catch (e) {
          // ignore
        }
      }
      return { protected: false, accounts: [], active: null };
    }
    if (rec.protected) {
      // encrypted: we cannot decrypt here without passphrase
      return rec; // caller should call unlockProtectedMeta(passphrase) to get decrypted data
    } else {
      return rec;
    }
  } catch (e) {
    return { protected: false, accounts: [], active: null };
  }
}

// unlock encrypted meta with passphrase (returns decrypted meta)
async function unlockProtectedMeta(passphrase) {
  const rec = await idbGet('meta');
  if (!rec || !rec.protected) throw new Error('no_protected_data');
  const salt = rec.salt;
  const key = await deriveKeyFromPassword(passphrase, salt);
  const decrypted = await decryptJSONWithKey(rec.data, key);
  // decrypted should be { accounts: [...], active: 'username' }
  return decrypted;
}

// enable protection (encrypt current plaintext meta with a passphrase)
async function enableProtectionWithPassphrase(passphrase) {
  const rec = await loadLocalMeta();
  if (!rec) return false;
  const salt = await genSaltBase64();
  const key = await deriveKeyFromPassword(passphrase, salt);
  const toEnc = { accounts: rec.accounts || [], active: rec.active || null };
  const enc = await encryptJSONWithKey(toEnc, key);
  const storeRec = { protected: true, salt, data: enc };
  await idbSet('meta', storeRec);
  // broadcast
  broadcastMetaUpdated();
  return true;
}

// disable protection: decrypt with passphrase then store plaintext
async function disableProtectionWithPassphrase(passphrase) {
  const dec = await unlockProtectedMeta(passphrase);
  const storeRec = { protected: false, accounts: dec.accounts || [], active: dec.active || null };
  await idbSet('meta', storeRec);
  broadcastMetaUpdated();
  return true;
}

// write plaintext meta (only used when not protected)
async function writePlainMeta(meta) {
  const rec = { protected: false, accounts: meta.accounts || [], active: meta.active || null };
  await idbSet('meta', rec);
  broadcastMetaUpdated();
}

async function writeEncryptedMetaUsingPassphrase(meta, passphrase) {
  const salt = await genSaltBase64();
  const key = await deriveKeyFromPassword(passphrase, salt);
  const enc = await encryptJSONWithKey({ accounts: meta.accounts || [], active: meta.active || null }, key);
  const rec = { protected: true, salt, data: enc };
  await idbSet('meta', rec);
  broadcastMetaUpdated();
}

/* ===========================
   High-level helpers for account metadata (used by UI)
   - saveAccountMeta(account, options)
     options: { protectWithPassphrase?: string } (optional)
   - removeAccountMeta(username)
   - setActiveAccountMeta(username)
   - loadMetaForUI(): returns decrypted meta if protected=false, or object { protected: true } indicating locked
   =========================== */

async function loadMetaForUI() {
  const rec = await loadLocalMeta();
  if (!rec) return { accounts: [], active: null, protected: false };
  if (!rec.protected) return { accounts: rec.accounts || [], active: rec.active || null, protected: false };
  // protected: return locked marker
  return { protected: true };
}

async function saveAccountMeta(account, options = {}) {
  if (!account || !account.username) return;
  const rec = await loadLocalMeta();
  if (rec.protected) {
    // encrypted store — require passphrase in options to update securely
    if (!options.passphrase) {
      // cannot update encrypted store without passphrase - fallback: do nothing
      console.warn('Protected meta: saveAccountMeta requires passphrase to update encrypted store.');
      return;
    }
    // unlock, update, re-encrypt (we do full rewrite)
    const dec = await unlockProtectedMeta(options.passphrase);
    const now = Date.now();
    const existingIndex = (dec.accounts || []).findIndex(a => a.username === account.username);
    const entry = {
      username: account.username,
      displayName: account.displayName || account.username,
      profilePic: account.profilePic || '/img/default_profile.png',
      addedAt: existingIndex >= 0 ? dec.accounts[existingIndex].addedAt : now,
      lastUsedAt: now,
      order: existingIndex >= 0 ? dec.accounts[existingIndex].order : (dec.accounts.length || 0)
    };
    if (existingIndex >= 0) dec.accounts[existingIndex] = Object.assign({}, dec.accounts[existingIndex], entry);
    else dec.accounts.push(entry);
    dec.active = account.username;
    await writeEncryptedMetaUsingPassphrase(dec, options.passphrase);
    return;
  } else {
    // plaintext store: update and save
    const now = Date.now();
    rec.accounts = rec.accounts || [];
    const existingIndex = rec.accounts.findIndex(a => a.username === account.username);
    const entry = {
      username: account.username,
      displayName: account.displayName || account.username,
      profilePic: account.profilePic || '/img/default_profile.png',
      addedAt: existingIndex >= 0 ? rec.accounts[existingIndex].addedAt : now,
      lastUsedAt: now,
      order: existingIndex >= 0 ? rec.accounts[existingIndex].order : (rec.accounts.length || 0)
    };
    if (existingIndex >= 0) rec.accounts[existingIndex] = Object.assign({}, rec.accounts[existingIndex], entry);
    else rec.accounts.push(entry);
    rec.active = account.username;
    await writePlainMeta(rec);
    return;
  }
}

async function removeAccountMeta(username, options = {}) {
  const rec = await loadLocalMeta();
  if (rec.protected) {
    if (!options.passphrase) {
      console.warn('Protected meta: removeAccountMeta requires passphrase.');
      return;
    }
    const dec = await unlockProtectedMeta(options.passphrase);
    dec.accounts = (dec.accounts || []).filter(a => a.username !== username);
    if (dec.active === username) dec.active = dec.accounts.length ? dec.accounts[0].username : null;
    await writeEncryptedMetaUsingPassphrase(dec, options.passphrase);
  } else {
    rec.accounts = (rec.accounts || []).filter(a => a.username !== username);
    if (rec.active === username) rec.active = rec.accounts.length ? rec.accounts[0].username : null;
    await writePlainMeta(rec);
  }
}

async function setActiveAccountMeta(username, options = {}) {
  const rec = await loadLocalMeta();
  if (rec.protected) {
    if (!options.passphrase) {
      console.warn('Protected meta: setActiveAccountMeta requires passphrase.');
      return;
    }
    const dec = await unlockProtectedMeta(options.passphrase);
    const idx = (dec.accounts || []).findIndex(a => a.username === username);
    const now = Date.now();
    if (idx >= 0) dec.accounts[idx].lastUsedAt = now;
    dec.active = username;
    await writeEncryptedMetaUsingPassphrase(dec, options.passphrase);
  } else {
    rec.accounts = rec.accounts || [];
    const idx = rec.accounts.findIndex(a => a.username === username);
    const now = Date.now();
    if (idx >= 0) rec.accounts[idx].lastUsedAt = now;
    rec.active = username;
    await writePlainMeta(rec);
  }
}

/* Broadcast helper */
function broadcastMetaUpdated() {
  try {
    if (window.BroadcastChannel) {
      const bc = new BroadcastChannel(BC_CHANNEL);
      bc.postMessage({ type: 'meta:updated' });
      bc.close();
    } else {
      localStorage.setItem(IDB_NAME + ':metaUpdatedAt', String(Date.now()));
    }
  } catch (e) {}
}

/* ===========================
   UI integration: dropdown, guards, render
   (the rest of UI code uses loadMetaForUI(), saveAccountMeta(), removeAccountMeta(), setActiveAccountMeta())
   =========================== */

function elFrom(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstChild;
}

let dropdownEl = null;
let dropdownVisible = false;
let outsidePointerGuard = null;
let outsideKeyGuard = null;

function ensureDropdown() {
  if (dropdownEl && document.body.contains(dropdownEl)) return dropdownEl;
  dropdownEl = document.createElement('div');
  dropdownEl.id = 'accountDropdown';
  dropdownEl.className = 'dropdown-panel';
  dropdownEl.style.display = 'none';
  dropdownEl.style.position = 'absolute';
  dropdownEl.style.right = '1rem';
  dropdownEl.style.top = '64px';
  dropdownEl.style.zIndex = '999';
  document.body.appendChild(dropdownEl);
  return dropdownEl;
}

function addOutsideGuards() {
  outsidePointerGuard = function (ev) {
    if (!dropdownVisible || !dropdownEl) return;
    if (dropdownEl.contains(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    hideDropdown();
  };
  document.addEventListener('pointerdown', outsidePointerGuard, true);

  outsideKeyGuard = function (ev) {
    if (ev.key === 'Escape' && dropdownVisible) {
      ev.preventDefault();
      hideDropdown();
    }
  };
  document.addEventListener('keydown', outsideKeyGuard, true);
}

function removeOutsideGuards() {
  if (outsidePointerGuard) {
    document.removeEventListener('pointerdown', outsidePointerGuard, true);
    outsidePointerGuard = null;
  }
  if (outsideKeyGuard) {
    document.removeEventListener('keydown', outsideKeyGuard, true);
    outsideKeyGuard = null;
  }
}

function showDropdown() {
  const d = ensureDropdown();
  d.style.display = 'block';
  dropdownVisible = true;
  addOutsideGuards();
}
function hideDropdown() {
  if (!dropdownEl) return;
  dropdownEl.style.display = 'none';
  dropdownVisible = false;
  removeOutsideGuards();
}

/* Basic server fetch helpers (unchanged) */
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

/* Render nav using loadMetaForUI and server fallback */
async function renderNav() {
  const nav = document.getElementById('navBar');
  if (!nav) return;
  nav.innerHTML = '';

  const left = elFrom(`<div style="display:flex;align-items:center;gap:12px;">
    <a href="/">หน้าแรก</a>
    <a href="/post/create">สร้างโพสต์</a>
  </div>`);
  nav.appendChild(left);

  const accountArea = document.createElement('div');
  accountArea.className = 'account-area';

  // prefer server authoritative data; fallback to local meta
  const accData = await fetchAccounts();
  const localMetaUI = await loadMetaForUI();

  let accountsToShow = [];
  let activeUsername = null;
  if (accData && accData.accounts) {
    accountsToShow = accData.accounts.map(a => ({ username: a.username, displayName: a.displayName, profilePic: a.profilePic }));
    activeUsername = accData.active;
    // sync server info to local plaintext for UX if meta not protected
    const rec = await loadLocalMeta();
    if (!rec.protected) {
      // update local meta (no secret)
      await writePlainMeta({ accounts: accountsToShow, active: activeUsername });
    }
  } else if (!localMetaUI.protected) {
    accountsToShow = localMetaUI.accounts;
    activeUsername = localMetaUI.active;
  } else {
    // locked protected meta: show limited UI
    accountArea.appendChild(elFrom('<a href="/login">เข้าสู่ระบบ</a>'));
    accountArea.appendChild(elFrom('<a href="/register">สมัครสมาชิก</a>'));
    nav.appendChild(accountArea);
    return;
  }

  // notification bell
  const notif = await fetchNotifications();
  const bell = document.createElement('div');
  bell.className = 'notify-bell';
  bell.style.position = 'relative';
  bell.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>`;
  if (notif && notif.unread && notif.unread > 0) {
    const badge = document.createElement('div');
    badge.className = 'notify-badge';
    badge.innerText = notif.unread > 99 ? '99+' : notif.unread;
    bell.appendChild(badge);
  }
  accountArea.appendChild(bell);

  if (accountsToShow && accountsToShow.length > 0) {
    const activeAcc = accountsToShow.find(a => a.username === activeUsername) || accountsToShow[0];
    const avatarUrl = activeAcc.profilePic || '/img/default_profile.png';

    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'avatar-btn';
    avatarBtn.innerHTML = `<img src="${avatarUrl}" class="avatar-img"> <span style="color:#fff">${activeAcc.displayName || activeAcc.username}</span>`;
    avatarBtn.style.border = 'none';
    avatarBtn.style.background = 'transparent';
    avatarBtn.style.cursor = 'pointer';
    accountArea.appendChild(avatarBtn);

    const dd = ensureDropdown();
    dd.innerHTML = '';

    avatarBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (dropdownVisible) { hideDropdown(); return; }
      // if local meta is protected and locked, prompt to unlock
      const localRec = await loadLocalMeta();
      if (localRec && localRec.protected) {
        // show locked UI with "Unlock" action
        dd.innerHTML = `<div style="padding:12px;"><strong>ข้อมูลบัญชีถูกป้องกัน</strong><div class="small">กรุณาป้อน passphrase เพื่อดูรายการบัญชี</div><div style="margin-top:.6rem;"><button id="unlockBtn">ปลดล็อค</button></div></div>`;
        const unlockBtn = dd.querySelector('#unlockBtn');
        unlockBtn.onclick = async () => {
          const pass = prompt('กรุณาป้อน passphrase เพื่อปลดล็อค (จะไม่ถูกส่งออกไปที่ server):');
          if (!pass) return;
          try {
            const dec = await unlockProtectedMeta(pass);
            // render unlocked list
            renderAccountListInto(dd, dec.accounts || [], dec.active || null, pass);
          } catch (e) {
            alert('ไม่สามารถปลดล็อคได้ (passphrase ผิดหรือข้อมูลเสียหาย)');
          }
        };
        showDropdown();
        return;
      }

      // normal rendering
      renderAccountListInto(dd, accountsToShow, activeUsername);
      showDropdown();
    });

    // bell -> notifications (same as earlier)
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

      const mar = dd.querySelector('#markAllRead');
      if (mar) {
        mar.onclick = async (ev) => {
          ev.preventDefault();
          await fetch('/api/notifications/mark-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
          hideDropdown();
          await renderNav();
        };
      }

      showDropdown();
    };

  } else {
    accountArea.appendChild(elFrom('<a href="/login">เข้าสู่ระบบ</a>'));
    accountArea.appendChild(elFrom('<a href="/register">สมัครสมาชิก</a>'));
  }

  nav.appendChild(accountArea);
}

/* Render accounts list into dropdown; if passphrasePresent, include it in remove/setActive calls */
function renderAccountListInto(dd, accountsList, activeUsername, passphraseForProtected = null) {
  dd.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'dropdown-header';
  header.style.padding = '12px';
  header.style.borderBottom = '1px solid #eee';
  const active = accountsList.find(a => a.username === activeUsername) || accountsList[0] || null;
  if (active) {
    header.innerHTML = `<img src="${active.profilePic||'/img/default_profile.png'}" class="avatar-img" style="width:40px;height:40px;margin-right:.5em"><div><div><strong>${active.displayName || active.username}</strong></div><div class="small">${active.username}</div></div>`;
  } else {
    header.innerHTML = `<div style="padding:8px;">ยังไม่มีบัญชี</div>`;
  }
  dd.appendChild(header);

  const list = document.createElement('div');
  list.className = 'dropdown-list';
  list.style.maxHeight = '320px';
  list.style.overflow = 'auto';
  dd.appendChild(list);

  for (let acc of accountsList) {
    if (acc.username === activeUsername) continue;
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.padding = '10px 12px';
    item.style.gap = '0.6rem';
    item.innerHTML = `<img src="${acc.profilePic||'/img/default_profile.png'}" class="avatar-img" style="width:32px;height:32px">
      <div style="flex:1">
        <div><strong>${acc.displayName || acc.username}</strong></div>
        <div class="small">${acc.username}</div>
      </div>
      <div style="min-width:80px; text-align:right;"><button class="btn-remove small" data-username="${acc.username}">Remove</button></div>`;
    item.style.cursor = 'pointer';

    item.onclick = async (e) => {
      if (e.target && e.target.tagName && (e.target.tagName.toLowerCase() === 'button')) return;
      if (!confirm(`สลับไปใช้บัญชี ${acc.username} ?`)) return;
      const r = await fetch('/api/accounts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: acc.username })
      });
      const d = await r.json();
      if (d.success) {
        // update local meta
        await setActiveAccountMeta(acc.username, passphraseForProtected ? { passphrase: passphraseForProtected } : {});
        await renderNav();
        hideDropdown();
        window.dispatchEvent(new Event('accountsChanged'));
      } else {
        alert(d.msg || 'ไม่สามารถสลับบัญชีได้');
      }
    };

    list.appendChild(item);
  }

  // footer
  const footer = document.createElement('div');
  footer.style.padding = '8px';
  footer.style.borderTop = '1px solid #eee';
  footer.style.display = 'flex';
  footer.style.justifyContent = 'space-between';
  footer.innerHTML = `<div><a href="/accounts" style="text-decoration:none">Manage accounts</a></div><div><button id="dropdownAddBtn">Add account</button></div>`;
  dd.appendChild(footer);

  // remove handlers
  dd.querySelectorAll('.btn-remove').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const username = btn.getAttribute('data-username');
      if (!confirm(`ลบบัญชี ${username} จากรายการหรือไม่?`)) return;
      await removeAccountMeta(username, passphraseForProtected ? { passphrase: passphraseForProtected } : {});
      await renderNav();
      hideDropdown();
      window.dispatchEvent(new Event('accountsChanged'));
    };
  });

  const addBtn = document.getElementById('dropdownAddBtn');
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.preventDefault();
      location.href = '/login?add=1';
    };
  }
}

/* Initialization & listeners */
if (window.BroadcastChannel) {
  try {
    const bc = new BroadcastChannel(BC_CHANNEL);
    bc.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'meta:updated') renderNav().catch(()=>{});
    };
  } catch (e) {}
} else {
  window.addEventListener('storage', (e) => {
    if (e.key === IDB_NAME + ':metaUpdatedAt') renderNav().catch(()=>{});
  });
}

window.addEventListener('load', async () => {
  await loadPartial('headerSlot', '/partial/header.html');
  await loadPartial('footerSlot', '/partial/footer.html');
  await renderNav();
});

/* expose a few helpers to global (for login page integration / settings)
   - saveAccountMeta(account, { passphrase })
   - enableProtectionWithPassphrase(passphrase)
   - disableProtectionWithPassphrase(passphrase)
   - unlockProtectedMeta(passphrase)  // returns decrypted meta
*/
window.communityStore = {
  saveAccountMeta,
  removeAccountMeta,
  setActiveAccountMeta,
  loadLocalMeta,
  loadMetaForUI,
  enableProtectionWithPassphrase,
  disableProtectionWithPassphrase,
  unlockProtectedMeta
};