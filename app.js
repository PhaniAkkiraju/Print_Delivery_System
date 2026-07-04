'use strict';

/* ============================================================
   FIREBASE REFERENCES
   auth, db, storage — globals set in firebase-config.js
   (loaded via Firebase Compat SDK CDN scripts in index.html)
============================================================ */

/* ============================================================
   STATE
============================================================ */
const S = {
  user:        null,       // {uid, username, email, role, joined, active}
  orders:      [],         // Synced via Firestore onSnapshot
  timers:      {},         // orderId → setInterval ID (client-side countdown)
  currentFile: null,       // File object for PDF upload
  opts: {
    color:    'color',
    sides:    'single',
    pageSize: 'A4',
    copies:   1,
    binding:  'none',
    quality:  'standard',
    pages:    'all',
    pageRange:'',
    numPages: 1
  },
  filter:       'active',
  trackingId:   null,
  pricing: {
    color: 10, bw: 2, single: 2, double: 1.5, a3: 5, spiral: 40, book: 60
  },
  coupons:      [],        // Synced via Firestore onSnapshot
  activeCoupon: null,
  inventory: {
    paperA4:    { name: 'A4 Paper',                count: 1200, max: 2000, unit: 'sheets', fill: '#1c768f' },
    paperA3:    { name: 'A3 Paper',                count: 450,  max: 800,  unit: 'sheets', fill: '#1c768f' },
    inkColor:   { name: 'Color Ink Cartridge',     count: 85,   max: 100,  unit: '%',      fill: '#FA991C' },
    inkBW:      { name: 'Black & White Ink Toner', count: 68,   max: 100,  unit: '%',      fill: '#032539' },
    spirals:    { name: 'Spiral Coils',            count: 80,   max: 150,  unit: 'pcs',   fill: '#1c768f' },
    bookCovers: { name: 'Hard Cover Bindings',     count: 45,   max: 100,  unit: 'pcs',   fill: '#1c768f' }
  },
  logs:        [],         // Synced via Firestore onSnapshot
  simSpeed:    1,
  supportAgent:'Priya',
  payMethod:   'upi'
};

/* ============================================================
   UTILS
============================================================ */
function $  (id)  { return document.getElementById(id); }
function qs (sel) { return document.querySelector(sel); }
function qsa(sel) { return document.querySelectorAll(sel); }

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-IN', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
}
function fmtSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(2) + ' MB';
}
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function uid() {
  return 'ORD-' + Date.now().toString(36).toUpperCase().slice(-6);
}

let _toastTimer;
function toast(msg, type = 'info') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = `toast ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.className = 'toast hidden', 3600);
}

/* ============================================================
   VIEW ROUTER
============================================================ */
function showView(id) {
  qsa('.view').forEach(v => v.classList.remove('active'));
  const t = $(id);
  if (t) t.classList.add('active');
}

function showTab(tab) {
  qsa('.dash-tab').forEach(t => t.classList.remove('active'));
  qsa('.nav-tab').forEach(t => t.classList.remove('active'));
  const tabEl = $('dashtab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  const btn = qs(`[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  if (tab === 'my-orders') renderOrders();
}

/* ============================================================
   FIRESTORE WRITE HELPERS
============================================================ */
async function fsUpdateOrder(orderId, data) {
  try { await db.collection('orders').doc(orderId).update(data); }
  catch(e) { console.error('fsUpdateOrder error:', e); }
}

async function fsWriteConfig(docId, data) {
  try { await db.collection('config').doc(docId).set(data, { merge: true }); }
  catch(e) { console.error('fsWriteConfig error:', e); }
}

async function fsAddLog(text, type = 'info') {
  try { await db.collection('logs').add({ text, type, time: Date.now() }); }
  catch(e) { console.error('fsAddLog error:', e); }
}

/* ============================================================
   FIRESTORE REAL-TIME LISTENERS
============================================================ */
let _unsubOrders  = null;
let _unsubConfig  = null;
let _unsubCoupons = null;
let _unsubLogs    = null;

function listenAll(userUid, isAdmin) {
  // ── Orders ──────────────────────────────────────────────
  if (_unsubOrders) _unsubOrders();
  let ordersQuery = db.collection('orders').orderBy('placedAt', 'desc');
  if (!isAdmin) ordersQuery = ordersQuery.where('uid', '==', userUid);

  _unsubOrders = ordersQuery.onSnapshot(snap => {
    S.orders = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    resumeTimers();
    updateBadge();
    if ($('dashtab-my-orders')?.classList.contains('active')) renderOrders();
    // Sync admin live panels
    const adminBtn = qs('.admin-menu-btn.active');
    if (adminBtn) {
      const t = adminBtn.dataset.adminTab;
      if (t === 'orders')    renderAdminOrdersTable();
      if (t === 'queue')     renderAdminPrintQueue();
      if (t === 'delivery')  renderAdminDeliveryRuns();
      if (t === 'dashboard') renderAdminTabContent('dashboard');
    }
  }, err => console.error('Orders listener error:', err));

  // ── Config (pricing, inventory, settings) ───────────────
  if (_unsubConfig) _unsubConfig();
  _unsubConfig = db.collection('config').onSnapshot(snap => {
    snap.docs.forEach(d => {
      if (d.id === 'pricing')   Object.assign(S.pricing,   d.data());
      if (d.id === 'inventory') Object.assign(S.inventory, d.data());
      if (d.id === 'settings') {
        if (d.data().simSpeed)     S.simSpeed    = d.data().simSpeed;
        if (d.data().supportAgent) S.supportAgent= d.data().supportAgent;
      }
    });
  }, err => console.error('Config listener error:', err));

  // ── Coupons ──────────────────────────────────────────────
  if (_unsubCoupons) _unsubCoupons();
  _unsubCoupons = db.collection('coupons').onSnapshot(snap => {
    S.coupons = snap.docs.map(d => d.data());
    const adminBtn = qs('.admin-menu-btn.active');
    if (adminBtn?.dataset.adminTab === 'coupons') renderAdminCoupons();
  }, err => console.error('Coupons listener error:', err));

  // ── Logs ─────────────────────────────────────────────────
  if (_unsubLogs) _unsubLogs();
  _unsubLogs = db.collection('logs').orderBy('time', 'desc').limit(50).onSnapshot(snap => {
    S.logs = snap.docs.map(d => d.data());
    const adminView  = $('view-admin');
    const dashPanel  = $('adminpanel-dashboard');
    if (adminView?.classList.contains('active') && dashPanel?.classList.contains('active')) {
      renderAdminLogs();
    }
  }, err => console.error('Logs listener error:', err));
}

function detachListeners() {
  if (_unsubOrders)  { _unsubOrders();  _unsubOrders  = null; }
  if (_unsubConfig)  { _unsubConfig();  _unsubConfig  = null; }
  if (_unsubCoupons) { _unsubCoupons(); _unsubCoupons = null; }
  if (_unsubLogs)    { _unsubLogs();    _unsubLogs    = null; }
}

/* ============================================================
   SEED INITIAL DATA  (runs once when Firestore is empty)
============================================================ */
async function seedInitialDataIfNeeded() {
  try {
    const pricingDoc = await db.collection('config').doc('pricing').get();
    if (!pricingDoc.exists) {
      await db.collection('config').doc('pricing').set(S.pricing);
      await db.collection('config').doc('inventory').set(S.inventory);
      await db.collection('config').doc('settings').set({ simSpeed: 1, supportAgent: 'Priya' });
      await db.collection('coupons').doc('PRINT10').set({ code: 'PRINT10', discount: 10, minAmount: 0 });
      await db.collection('coupons').doc('FREESHIP').set({ code: 'FREESHIP', discount: 15, minAmount: 100 });
      await db.collection('logs').add({ text: 'System booted. PrintIt micro-hub operational.', type: 'success', time: Date.now() });
    }
  } catch(e) { console.error('Seed error:', e); }
}

/* ============================================================
   AUTH
============================================================ */
function initAuth() {
  // ── Tab toggling ──────────────────────────────────────────
  const tabLogin = $('auth-tab-login');
  const tabReg   = $('auth-tab-register');
  if (tabLogin && tabReg) {
    tabLogin.onclick = () => {
      tabLogin.classList.add('active');   tabReg.classList.remove('active');
      $('auth-form-login').classList.remove('hidden');
      $('auth-form-register').classList.add('hidden');
    };
    tabReg.onclick = () => {
      tabReg.classList.add('active');    tabLogin.classList.remove('active');
      $('auth-form-register').classList.remove('hidden');
      $('auth-form-login').classList.add('hidden');
    };
  }

  // ── OTP button — Firebase handles verification natively ──
  $('btn-reg-send-otp').onclick = (e) => {
    e.preventDefault();
    toast('ℹ️ Email verification is handled by Firebase — just register directly!', 'info');
  };

  // ── REGISTER ─────────────────────────────────────────────
  $('btn-register-submit').onclick = async () => {
    const username = $('reg-username').value.trim();
    const email    = $('reg-email').value.trim();
    const password = $('reg-password').value.trim();
    const phone    = $('reg-phone').value.trim();

    if (!username || !email || !password || !phone) {
      toast('Please fill all registration fields', 'error'); return;
    }
    if (password.length < 6) {
      toast('Password must be at least 6 characters', 'error'); return;
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      toast('Please enter a valid 10-digit Indian mobile number', 'error'); return;
    }

    const btn = $('btn-register-submit');
    btn.disabled = true; btn.textContent = 'Creating account…';

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      const role = email.toLowerCase() === 'admin@printit.in' ? 'admin' : 'customer';
      await db.collection('users').doc(cred.user.uid).set({
        username, email, phone, role, joined: Date.now(), active: true
      });
      fsAddLog(`New account registered: ${username} <${email}>`, 'success');
      toast('🎉 Account created! Logging you in…', 'success');
      // onAuthStateChanged handles navigation
    } catch(err) {
      let msg = 'Registration failed. Please try again.';
      if (err.code === 'auth/email-already-in-use') msg = 'An account with this email already exists.';
      if (err.code === 'auth/invalid-email')        msg = 'Please enter a valid email address.';
      if (err.code === 'auth/weak-password')        msg = 'Password must be at least 6 characters.';
      toast('❌ ' + msg, 'error');
      btn.disabled = false; btn.textContent = 'Create Account';
    }
  };

  // ── LOGIN ─────────────────────────────────────────────────
  $('btn-login-submit').onclick = async () => {
    const email    = $('login-email').value.trim();
    const password = $('login-password').value.trim();

    if (!email || !password) {
      toast('Please enter email and password', 'error'); return;
    }

    const btn = $('btn-login-submit');
    btn.disabled = true; btn.textContent = 'Signing in…';

    try {
      await auth.signInWithEmailAndPassword(email, password);
      // onAuthStateChanged handles navigation
    } catch(err) {
      let msg = 'Invalid email or password.';
      if (err.code === 'auth/user-not-found')    msg = 'No account found with this email.';
      if (err.code === 'auth/wrong-password')    msg = 'Incorrect password.';
      if (err.code === 'auth/invalid-email')     msg = 'Please enter a valid email.';
      if (err.code === 'auth/too-many-requests') msg = 'Too many attempts. Try again later.';
      if (err.code === 'auth/invalid-credential')msg = 'Invalid email or password.';
      toast('❌ ' + msg, 'error');
      btn.disabled = false; btn.textContent = 'Login';
    }
  };
}

/* ============================================================
   DASHBOARD
============================================================ */
function initDashboard() {
  const name  = S.user?.username || 'User';
  const email = S.user?.email    || '';
  $('nav-phone').textContent  = email;
  $('nav-name').textContent   = name;
  $('nav-avatar').textContent = name.charAt(0).toUpperCase() || 'U';

  // Logout
  $('btn-logout').onclick = async () => {
    Object.values(S.timers).forEach(clearInterval);
    S.timers = {};
    detachListeners();
    S.user = null; S.orders = [];
    await auth.signOut();
    showView('view-login');
    $('login-email').value    = '';
    $('login-password').value = '';
    toast('Logged out', 'info');
  };

  qsa('[data-tab]').forEach(btn => {
    btn.onclick = () => showTab(btn.dataset.tab);
  });

  initOrderForm();
  resumeTimers();
  updateBadge();
  initFaqAccordion();
  initAccountView();
  initCouponHandler();
}

function initFaqAccordion() {
  qsa('.faq-item').forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      const ans      = item.querySelector('.faq-answer');
      const isHidden = ans.classList.contains('hidden');
      qsa('.faq-answer').forEach(a => a.classList.add('hidden'));
      qsa('.faq-item').forEach(i => i.classList.remove('active'));
      if (isHidden) { ans.classList.remove('hidden'); item.classList.add('active'); }
    };
  });
}

function initAccountView() {
  if (!S.user) return;
  const username = S.user.username || 'User';
  $('acc-username').textContent     = username;
  $('acc-email').textContent        = S.user.email || '';
  $('acc-date').textContent         = fmtDate(S.user.joined || Date.now());
  $('acc-orders-count').textContent = S.orders.filter(o => o.uid === S.user.uid || o.username === username).length;
  $('acc-big-avatar').textContent   = username.charAt(0).toUpperCase();
  // Show phone if available
  const phoneEl = $('acc-phone');
  if (phoneEl) phoneEl.textContent = S.user.phone ? `📱 ${S.user.phone}` : '';

  $('btn-update-password').onclick = async () => {
    const newPass = $('acc-new-password').value.trim();
    if (!newPass || newPass.length < 6) {
      toast('New password must be at least 6 characters', 'error'); return;
    }
    try {
      await auth.currentUser.updatePassword(newPass);
      toast('🔑 Password updated successfully!', 'success');
      $('acc-curr-password').value = '';
      $('acc-new-password').value  = '';
    } catch(err) {
      if (err.code === 'auth/requires-recent-login') {
        toast('Please log out and log back in before changing your password.', 'error');
      } else {
        toast('Failed to update password. Please try again.', 'error');
      }
    }
  };
}

/* ============================================================
   ORDER FORM
============================================================ */
function initOrderForm() {
  const dz      = $('dropzone');
  const fileIn  = $('file-input');
  const btnBrws = $('btn-browse');

  btnBrws.addEventListener('click', () => fileIn.click());
  dz.addEventListener('click', e => { if (!btnBrws.contains(e.target)) fileIn.click(); });
  fileIn.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $('btn-remove-file').addEventListener('click', () => {
    S.currentFile = null;
    $('file-preview').classList.add('hidden');
    fileIn.value = '';
  });

  const toggleMap = {
    'opt-color':   'color',
    'opt-sides':   'sides',
    'opt-binding': 'binding',
    'opt-quality': 'quality',
    'opt-pages':   'pages'
  };
  Object.entries(toggleMap).forEach(([groupId, key]) => {
    const group = $(groupId);
    if (!group) return;
    group.querySelectorAll('.tog').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.tog').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        S.opts[key] = btn.dataset.value;
        if (key === 'pages') $('page-range-input').classList.toggle('hidden', btn.dataset.value !== 'custom');
        updateSummary();
      });
    });
  });

  $('opt-pagesize').addEventListener('change', e => { S.opts.pageSize = e.target.value; updateSummary(); });

  $('num-copies').addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    S.opts.copies = (isNaN(v) || v < 1) ? 1 : v;
    updateSummary();
  });
  $('num-copies').addEventListener('blur', e => { e.target.value = S.opts.copies; });
  $('page-range-input').addEventListener('input', e => { S.opts.pageRange = e.target.value; });

  $('btn-place-order').addEventListener('click', showPaymentModal);
  updateSummary();
}

async function countPdfPages(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFLib.PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    return pdfDoc.getPageCount();
  } catch (err) {
    console.error('PDF parsing error:', err);
    return 1; // Fallback if parsing fails
  }
}

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    toast('⚠️ Only PDF files are accepted!', 'error'); return;
  }
  S.currentFile = file;
  $('fp-name').textContent = file.name;
  $('fp-size').textContent = fmtSize(file.size) + ' (Calculating pages...)';
  $('file-preview').classList.remove('hidden');

  countPdfPages(file).then(pages => {
    S.opts.numPages = pages;
    $('fp-size').textContent = `${fmtSize(file.size)} (${pages} page${pages > 1 ? 's' : ''})`;
    updateSummary();
    toast(`✅ PDF ready: ${file.name} (${pages} pages)`, 'success');
  });
}

const BINDING_LABELS = { none:'No Binding', spiral:'🌀 Spiral', book:'📖 Book' };

function calculatePrice() {
  const o          = S.opts;
  const p          = S.pricing;
  const colorRate  = o.color   === 'color'  ? p.color  : p.bw;
  const sideRate   = o.sides   === 'single' ? p.single : p.double;
  const sizeRate   = o.pageSize === 'A3' ? p.a3 : (o.pageSize === 'Letter' ? 1.5 : (o.pageSize === 'Legal' ? 2 : 0));
  const bindingCost= o.binding === 'spiral' ? p.spiral : (o.binding === 'book' ? p.book : 0);

  const numP             = o.numPages || 1;
  const copies           = o.copies   || 1;
  const printCostPerPage = colorRate + sideRate + sizeRate;
  const printSubtotal    = printCostPerPage * numP;
  const totalPerCopy     = printSubtotal + bindingCost;
  let   grandTotal       = totalPerCopy * copies;
  let   discountAmount   = 0;

  if (S.activeCoupon) {
    if (grandTotal >= S.activeCoupon.minAmount) {
      discountAmount = Math.round((grandTotal * S.activeCoupon.discount) / 100);
      grandTotal     = Math.max(0, grandTotal - discountAmount);
    } else {
      S.activeCoupon = null;
    }
  }

  return { colorRate, sideRate, sizeRate, bindingCost, printCostPerPage,
           printSubtotal, totalPerCopy, grandTotal, discountAmount, numPages: numP, copies };
}

function updateSummary() {
  const o = S.opts;
  $('s-color').textContent   = o.color   === 'color'  ? '🎨 Color'    : '⬛ B&W';
  $('s-sides').textContent   = o.sides   === 'single' ? 'Single Side' : 'Double Side';
  $('s-size').textContent    = o.pageSize;
  $('s-copies').textContent  = o.copies + ' Cop' + (o.copies > 1 ? 'ies' : 'y');
  $('s-binding').textContent = BINDING_LABELS[o.binding] || o.binding;
  $('s-quality').textContent = o.quality === 'standard' ? 'Standard' : '✨ Premium';

  const pi = calculatePrice();
  $('price-total').textContent = `₹ ${pi.grandTotal}`;

  const bEl = $('price-breakdown');
  if (bEl) {
    bEl.innerHTML = `
      <div class="pb-row">
        <span class="pb-lbl">Printing (${pi.numPages} pgs × ₹${pi.printCostPerPage}/pg)</span>
        <span class="pb-val">₹ ${pi.printSubtotal}</span>
      </div>
      ${pi.bindingCost > 0 ? `
      <div class="pb-row">
        <span class="pb-lbl">Binding (${BINDING_LABELS[o.binding]})</span>
        <span class="pb-val">₹ ${pi.bindingCost}</span>
      </div>` : ''}
      <div class="pb-row" style="border-top:1px dashed rgba(28,118,143,0.1);margin-top:4px;padding-top:4px">
        <span class="pb-lbl">Subtotal per copy</span>
        <span class="pb-val">₹ ${pi.totalPerCopy}</span>
      </div>
      <div class="pb-row">
        <span class="pb-lbl">Copies</span>
        <span class="pb-val">× ${pi.copies}</span>
      </div>
      ${pi.discountAmount > 0 ? `
      <div class="pb-row" style="color: var(--green); font-weight: bold;">
        <span class="pb-lbl">🎟️ Coupon Discount (${S.activeCoupon.code})</span>
        <span class="pb-val">- ₹ ${pi.discountAmount}</span>
      </div>` : ''}
    `;
  }
}

function initCouponHandler() {
  const btnApply = $('btn-apply-coupon');
  const input    = $('coupon-input');
  if (!btnApply || !input) return;

  btnApply.onclick = () => {
    const code   = input.value.trim().toUpperCase();
    if (!code) { toast('Please enter a coupon code', 'error'); return; }

    const coupon = S.coupons.find(c => c.code.toUpperCase() === code);
    if (!coupon) { toast('Invalid coupon code', 'error'); return; }

    const pi      = calculatePrice();
    const subtotal= pi.totalPerCopy * pi.copies;
    if (subtotal < coupon.minAmount) {
      toast(`Min order amount for this coupon is ₹${coupon.minAmount}`, 'error'); return;
    }

    S.activeCoupon = coupon;
    updateSummary();
    toast(`🎟️ Coupon ${coupon.code} applied successfully!`, 'success');
  };
}

/* ============================================================
   PAYMENT MODAL
============================================================ */
let _currentPaymentAmount    = 0;
let _currentPaymentBreakdown = '';

function showPaymentModal() {
  if (!S.currentFile) { toast('📄 Please upload a PDF file first!', 'error'); return; }
  const addr = $('delivery-address').value.trim();
  if (!addr) { toast('📍 Please enter a delivery address!', 'error'); $('delivery-address').focus(); return; }

  const pi = calculatePrice();
  _currentPaymentAmount = pi.grandTotal;

  const o      = S.opts;
  const bLabel = BINDING_LABELS[o.binding] || o.binding;
  _currentPaymentBreakdown = `
    ${pi.numPages} pgs × ₹${pi.printCostPerPage}/pg (${o.color === 'color' ? 'Color' : 'B&W'}, ${o.sides === 'single' ? 'Single' : 'Double'})<br>
    ${pi.bindingCost > 0 ? `+ ₹${pi.bindingCost} Binding (${bLabel})<br>` : ''}
    × ${pi.copies} cop${pi.copies > 1 ? 'ies' : 'y'}
  `;

  $('pay-amount').textContent        = `₹ ${_currentPaymentAmount}`;
  $('pay-breakdown-modal').innerHTML = _currentPaymentBreakdown;

  setPaymentMethod('upi');
  $('upi-id').value = ''; $('card-number').value = ''; $('card-expiry').value = ''; $('card-cvv').value = '';
  $('payment-modal').classList.remove('hidden');
}

function setPaymentMethod(method) {
  S.payMethod = method;
  qsa('.pay-method-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.method === method));
  $('pay-form-upi').classList.toggle('hidden',  method !== 'upi');
  $('pay-form-card').classList.toggle('hidden', method !== 'card');
  $('pay-form-cod').classList.toggle('hidden',  method !== 'cod');
  $('pay-btn-text').textContent = method === 'cod' ? 'Confirm Order (COD)' : `Pay ₹ ${_currentPaymentAmount}`;
}

function initPayment() {
  qsa('.pay-method-btn').forEach(btn => btn.addEventListener('click', () => setPaymentMethod(btn.dataset.method)));
  $('btn-close-payment').addEventListener('click', () => $('payment-modal').classList.add('hidden'));
  $('btn-pay-now').addEventListener('click', processPayment);

  $('card-number').addEventListener('input', e => {
    const v = e.target.value.replace(/\s+/g, '').replace(/[^0-9]/gi, '');
    const m = v.match(/\d{4,16}/g), match = m && m[0] || '';
    const parts = [];
    for (let i = 0; i < match.length; i += 4) parts.push(match.substring(i, i+4));
    e.target.value = parts.length ? parts.join('  ') : v;
  });

  $('card-expiry').addEventListener('input', e => {
    const v = e.target.value.replace(/\s+/g, '').replace(/[^0-9]/gi, '');
    e.target.value = v.length >= 2 ? v.substring(0,2) + ' / ' + v.substring(2,4) : v;
  });
}

function processPayment() {
  const method = S.payMethod;
  if (method === 'upi') {
    const u = $('upi-id').value.trim();
    if (!u)              { toast('Please enter your UPI ID', 'error'); $('upi-id').focus(); return; }
    if (!u.includes('@')){ toast('Please enter a valid UPI ID (e.g. name@upi)', 'error'); $('upi-id').focus(); return; }
  } else if (method === 'card') {
    const num = $('card-number').value.replace(/\s+/g, '');
    const exp = $('card-expiry').value.replace(/\s+/g, '');
    const cvv = $('card-cvv').value.trim();
    if (num.length < 16) { toast('Please enter a valid 16-digit card number', 'error'); $('card-number').focus(); return; }
    if (exp.length < 5)  { toast('Please enter expiry date (MM / YY)', 'error'); $('card-expiry').focus(); return; }
    if (cvv.length < 3)  { toast('Please enter 3-digit CVV', 'error'); $('card-cvv').focus(); return; }
  }

  $('payment-modal').classList.add('hidden');
  toast('💳 Payment processed successfully!', 'success');
  confirmPaymentAndPlaceOrder();
}

async function confirmPaymentAndPlaceOrder() {
  const addr    = $('delivery-address').value.trim();
  const deliSec = Math.floor(Math.random() * (840 - 180 + 1)) + 180;
  const pi      = calculatePrice();
  const orderId = uid();

  const payMethodLabels = { upi: '💳 UPI', card: '💳 Debit Card', cod: '💵 COD' };

  // ── Upload PDF to Firebase Storage ────────────────────────
  let fileUrl = '';
  try {
    const ref      = storage.ref(`pdfs/${S.user.uid}/${orderId}.pdf`);
    const snapshot = await ref.put(S.currentFile);
    fileUrl        = await snapshot.ref.getDownloadURL();
    toast('📤 PDF uploaded to cloud', 'success');
  } catch(err) {
    console.warn('Storage upload failed (continuing without URL):', err);
  }

  const order = {
    id:        orderId,
    uid:       S.user.uid || '',
    username:  S.user.username || 'user',
    fileName:  S.currentFile.name,
    fileSize:  fmtSize(S.currentFile.size),
    fileUrl:   fileUrl,
    color:     S.opts.color,
    copies:    S.opts.copies,
    sides:     S.opts.sides,
    pageSize:  S.opts.pageSize,
    binding:   S.opts.binding,
    quality:   S.opts.quality,
    pages:     S.opts.pages,
    pageRange: S.opts.pageRange,
    address:   addr,
    deliSec:   deliSec,
    placedAt:  Date.now(),
    status:    'active',
    price:     pi.grandTotal,
    payMethod: payMethodLabels[S.payMethod] || S.payMethod
  };

  // ── Inventory deductions ─────────────────────────────────
  const totalSheets = order.copies * (S.opts.numPages || 1);
  if (order.pageSize === 'A3') S.inventory.paperA3.count = Math.max(0, S.inventory.paperA3.count - totalSheets);
  else                         S.inventory.paperA4.count = Math.max(0, S.inventory.paperA4.count - totalSheets);
  if (order.color === 'color') S.inventory.inkColor.count = Math.max(0, S.inventory.inkColor.count - Math.ceil(totalSheets * 0.4));
  else                         S.inventory.inkBW.count    = Math.max(0, S.inventory.inkBW.count    - Math.ceil(totalSheets * 0.1));
  if (order.binding === 'spiral') S.inventory.spirals.count    = Math.max(0, S.inventory.spirals.count    - order.copies);
  if (order.binding === 'book')   S.inventory.bookCovers.count = Math.max(0, S.inventory.bookCovers.count - order.copies);

  // ── Write to Firestore ───────────────────────────────────
  try {
    await db.collection('orders').doc(orderId).set(order);
    await fsWriteConfig('inventory', S.inventory);
    await fsAddLog(`New order placed by ${order.username}: ${orderId} for ₹${order.price}`, 'success');
    // Immediately add to local state so showTrackingModal works before onSnapshot fires
    if (!S.orders.find(o => o.id === orderId)) {
      S.orders.unshift(order);
    }
  } catch(err) {
    console.error('Error writing order to Firestore:', err);
    // Fallback: keep in local state so UI still works this session
    S.orders.unshift(order);
    toast('⚠️ Order placed but sync failed — check your connection.', 'error');
  }

  S.activeCoupon  = null;
  S.currentFile   = null;
  $('file-preview').classList.add('hidden');
  $('file-input').value       = '';
  $('delivery-address').value = '';
  if ($('num-copies')) $('num-copies').value = '1';
  S.opts.numPages = 1;
  S.opts.copies   = 1;

  // Pass the full order object directly — no onSnapshot lookup needed
  startTimer(orderId);
  updateBadge();
  showTrackingModal(order);   // ← order object, always found
}

/* ============================================================
   TIMERS  (client-side countdown, writes only on status change)
============================================================ */
function getRemaining(order) {
  if (order.status === 'delivered' || order.status === 'cancelled') return 0;
  const elapsed = Math.floor((Date.now() - order.placedAt) / 1000) * (S.simSpeed || 1);
  return Math.max(0, order.deliSec - elapsed);
}

function startTimer(id) {
  if (S.timers[id]) return;

  const tick = () => {
    const order = S.orders.find(o => o.id === id);
    if (!order || order.status === 'delivered') {
      clearInterval(S.timers[id]); delete S.timers[id]; return;
    }
    const rem = getRemaining(order);
    if (rem <= 0) {
      completeOrder(id);
    } else {
      const pct = ((order.deliSec - rem) / order.deliSec) * 100;
      refreshCardTimer(id, rem, pct);
      if (S.trackingId === id) updateModalTimer(rem, order.deliSec);
    }
  };

  S.timers[id] = setInterval(tick, 1000);
  tick();
}

function completeOrder(id) {
  const order = S.orders.find(o => o.id === id);
  if (!order || order.status === 'delivered') return;

  // ── Local UI-only update ────────────────────────────────────────────────
  // The authoritative Firestore write is handled by the server-side Cloud
  // Function (functions/index.js → completeDeliveredOrders). That function
  // runs on a 1-minute schedule and uses the Admin SDK, which bypasses
  // Firestore security rules. Once it writes, the onSnapshot listener in
  // listenAll() will sync the real status back to this client automatically.
  //
  // We mutate local state here only so the countdown / animations resolve
  // immediately in this browser tab — no Firestore write from the client.
  order.status      = 'delivered';
  order.deliveredAt = Date.now();
  clearInterval(S.timers[id]); delete S.timers[id];
  updateBadge();

  if ($('dashtab-my-orders')?.classList.contains('active')) renderOrders();
  if (S.trackingId === id) onModalDelivered(id);
  toast(`✅ Order ${id} has been delivered!`, 'success');
}

function refreshCardTimer(id, rem, pct) {
  const card = qs(`[data-oid="${id}"]`);
  if (!card) return;
  const t = card.querySelector('.cd-t');
  const b = card.querySelector('.mini-bar-fill');
  if (t) t.textContent = fmtTime(rem);
  if (b) b.style.width = pct + '%';
}

function resumeTimers() {
  S.orders.forEach(o => {
    if (o.status === 'active') {
      if (getRemaining(o) <= 0) completeOrder(o.id);
      else startTimer(o.id);
    }
  });
}

/* ============================================================
   TRACKING MODAL
============================================================ */
// Accepts either an order ID (string) OR a full order object
function showTrackingModal(idOrOrder) {
  const id    = (typeof idOrOrder === 'object') ? idOrOrder.id : idOrOrder;
  const order = (typeof idOrOrder === 'object') ? idOrOrder : S.orders.find(o => o.id === id);
  if (!order) return;   // safety guard
  S.trackingId = id;

  const modal = $('tracking-modal');
  modal.classList.remove('hidden');

  ['step-print','step-pack','step-way','step-done'].forEach(s => $(s)?.classList.remove('active'));
  ['sl-1','sl-2','sl-3'].forEach(s => $(s)?.classList.remove('active'));
  $('step-print')?.classList.add('active');
  $('modal-hdr-icon').textContent = '🎉';

  const bLabel = BINDING_LABELS[order.binding] || order.binding;
  $('modal-order-info').innerHTML = `
    <strong>📄 ${esc(order.fileName)}</strong>
    &nbsp;•&nbsp; ${order.color === 'color' ? '🎨 Color' : '⬛ B&W'}
    &nbsp;•&nbsp; ${order.copies} cop${order.copies > 1 ? 'ies' : 'y'}
    &nbsp;•&nbsp; ${order.pageSize}
    &nbsp;•&nbsp; ${order.sides === 'single' ? 'Single-side' : 'Double-side'}
    ${order.binding !== 'none' ? `&nbsp;•&nbsp; ${bLabel}` : ''}
    &nbsp;•&nbsp; ${order.quality === 'standard' ? 'Standard' : '✨ Premium'}
    &nbsp;•&nbsp; <strong style="color:var(--txt)">₹ ${order.price || 0}</strong> via ${order.payMethod || 'Paid'}
    <br><span style="color:#94a3b8;font-size:.8rem">📍 ${esc(order.address)}</span>
  `;

  updateModalTimer(getRemaining(order), order.deliSec);

  $('btn-close-tracking').onclick = closeModal;
  $('btn-goto-orders').onclick    = () => { closeModal(); showTab('my-orders'); };
  modal.onclick = e => { if (e.target === modal) closeModal(); };
}

function closeModal() {
  $('tracking-modal').classList.add('hidden');
  S.trackingId = null;
}

const CIRCUMFERENCE = 2 * Math.PI * 63;

function updateModalTimer(rem, total) {
  const pct = (total - rem) / total;
  $('cd-time').textContent = fmtTime(rem);

  const ring = $('ring-fg');
  if (ring) ring.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);

  const fill = $('track-fill');
  if (fill) fill.style.width = (pct * 100) + '%';

  const bike = $('track-bike');
  if (bike) bike.style.left = (5 + pct * 78) + '%';

  if (pct >= 0)    { $('step-print')?.classList.add('active'); }
  if (pct >= 0.25) { $('step-pack')?.classList.add('active'); $('sl-1')?.classList.add('active'); }
  if (pct >= 0.55) { $('step-way')?.classList.add('active');  $('sl-2')?.classList.add('active'); }
  if (pct >= 1)    { $('step-done')?.classList.add('active'); $('sl-3')?.classList.add('active'); }
}

function onModalDelivered(id) {
  $('cd-time').textContent        = '00:00';
  $('modal-hdr-icon').textContent = '✅';
  updateModalTimer(0, 1);
  const bike = $('track-bike');
  if (bike) { bike.textContent = '✅'; bike.style.left = '88%'; }
  if ($('dashtab-my-orders')?.classList.contains('active')) renderOrders();
}

/* ============================================================
   BADGE
============================================================ */
function updateBadge() {
  const n  = S.orders.filter(o => o.status === 'active').length;
  const el = $('nav-badge');
  if (!el) return;
  el.textContent = n;
  el.classList.toggle('hidden', n === 0);
}

/* ============================================================
   ORDERS LIST
============================================================ */
function renderOrders() {
  const list = $('orders-list');
  if (!list) return;

  const myOrders = S.user?.role === 'admin'
    ? S.orders
    : S.orders.filter(o => o.uid === S.user?.uid || o.username === S.user?.username);

  const filter = S.filter;
  const items  = myOrders.filter(o => o.status === filter);
  const aC     = myOrders.filter(o => o.status === 'active').length;
  const dC     = myOrders.filter(o => o.status === 'delivered').length;

  $('count-active').textContent    = aC;
  $('count-delivered').textContent = dC;

  if (items.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${filter === 'active' ? '⏳' : '📭'}</div>
        <h3>${filter === 'active' ? 'No active orders' : 'No delivered orders yet'}</h3>
        <p>${filter === 'active'
              ? 'Place your first print order to see it here.'
              : 'Completed orders will appear here.'}</p>
        ${filter === 'active' ? `<button class="btn-primary" id="btn-empty-order">Place an Order</button>` : ''}
      </div>`;
    $('btn-empty-order')?.addEventListener('click', () => showTab('place-order'));
    return;
  }

  list.innerHTML = items.map(o => orderCard(o)).join('');
  items.filter(o => o.status === 'active').forEach(o => {
    qs(`[data-oid="${o.id}"]`)?.addEventListener('click', () => showTrackingModal(o.id));
  });
}

function orderCard(o) {
  const isActive = o.status === 'active';
  const rem = isActive ? getRemaining(o) : 0;
  const pct = isActive ? ((o.deliSec - rem) / o.deliSec * 100) : 100;
  const bl  = BINDING_LABELS[o.binding] || o.binding;

  return `
  <div class="order-card ${isActive ? 'is-active' : 'is-delivered'}" data-oid="${o.id}">
    <div class="oc-top">
      <div class="oc-left">
        <div class="oc-ficon">📄</div>
        <div>
          <div class="oc-filename">${esc(o.fileName)}</div>
          <div class="oc-id">${o.id} &nbsp;•&nbsp; ${fmtDate(o.placedAt)}</div>
        </div>
      </div>
      <div class="status-badge ${isActive ? 'badge-active' : 'badge-done'}">
        ${isActive ? '🔴 In Progress' : '✅ Delivered'}
      </div>
    </div>
    <div class="oc-chips">
      <span class="chip">${o.color === 'color' ? '🎨 Color' : '⬛ B&W'}</span>
      <span class="chip">${o.copies} cop${o.copies > 1 ? 'ies' : 'y'}</span>
      <span class="chip">${o.pageSize}</span>
      <span class="chip">${o.sides === 'single' ? 'Single-side' : 'Double-side'}</span>
      <span class="chip">${bl}</span>
      <span class="chip">${o.quality === 'standard' ? 'Standard' : '✨ Premium'}</span>
      <span class="chip">${o.fileSize}</span>
      <span class="chip" style="font-weight:700;color:var(--red);background:#fff5f5;border-color:rgba(232,64,64,0.15)">₹ ${o.price || 0}</span>
      <span class="chip" style="background:#eef2ff;color:#4f46e5;border-color:#e0e7ff">${o.payMethod || 'Paid'}</span>
    </div>
    <div class="oc-address">📍 ${esc(o.address)}</div>
    ${isActive ? `
      <div class="cd-row">
        <div class="cd-left">
          <div class="cd-lbl-sm">Estimated Delivery</div>
          <div class="cd-t">${fmtTime(rem)}</div>
        </div>
        <div class="mini-bar"><div class="mini-bar-fill" style="width:${pct}%"></div></div>
        <span class="cd-scooter">🛵</span>
      </div>
      <div class="click-hint">Click to open live tracking</div>
    ` : `
      <div class="delivered-tag">✅ Delivered on ${fmtDate(o.deliveredAt)}</div>
    `}
  </div>`;
}

/* ============================================================
   FILTER BUTTONS
============================================================ */
function initFilters() {
  ['active','delivered'].forEach(f => {
    $('fb-' + f)?.addEventListener('click', () => {
      S.filter = f;
      qsa('.filter-btn').forEach(b => b.classList.remove('active'));
      $('fb-' + f)?.classList.add('active');
      renderOrders();
    });
  });
}

/* ============================================================
   CUSTOMER SUPPORT WIDGET
============================================================ */
function initSupport() {
  const trigger = $('support-trigger');
  const widget  = $('support-widget');
  const close   = $('support-close');
  const sendBtn = $('btn-support-send');
  const input   = $('support-input');
  const area    = $('support-msg-area');
  if (!trigger || !widget) return;

  trigger.onclick  = () => {
    widget.classList.toggle('hidden');
    const badge = trigger.querySelector('.st-badge');
    if (badge) badge.remove();
    if (!widget.classList.contains('hidden')) { input.focus(); scrollChat(); }
  };
  close.onclick    = () => widget.classList.add('hidden');
  sendBtn.onclick  = send;
  input.onkeydown  = e => { if (e.key === 'Enter') send(); };

  qsa('.support-qr-btn').forEach(btn => {
    btn.onclick = () => { addUser(btn.dataset.query); setTimeout(() => reply(btn.dataset.query), 700); };
  });

  function send() {
    const txt = input.value.trim(); if (!txt) return;
    input.value = ''; addUser(txt); setTimeout(() => reply(txt), 700);
  }
  function addUser(msg) {
    const b = document.createElement('div');
    b.className = 'support-bubble bubble-user'; b.textContent = msg;
    area.appendChild(b); scrollChat();
  }
  function addAgent(msg) {
    const b = document.createElement('div');
    b.className = 'support-bubble bubble-agent'; b.innerHTML = msg;
    area.appendChild(b); scrollChat();
  }
  function scrollChat() { area.scrollTop = area.scrollHeight; }

  function reply(q) {
    q = q.toLowerCase();
    let res = '';
    if (q.includes('track') || q.includes('status') || q.includes('where'))
      res = `🛵 Track your orders in the <strong>My Orders</strong> tab! Click any active order to open live tracking.`;
    else if (q.includes('price') || q.includes('charge') || q.includes('cost') || q.includes('rate'))
      res = `💰 Pricing:<br>• 🎨 <strong>Color:</strong> ₹10/pg<br>• ⬛ <strong>B&W:</strong> ₹2/pg<br>• Single Side: +₹2/pg<br>• Double Side: +₹1.5/pg<br>• Binding: Spiral +₹40, Book +₹60`;
    else if (q.includes('time') || q.includes('deliver') || q.includes('fast') || q.includes('when'))
      res = `⏱️ Delivery in <strong>under 15 minutes</strong>! Check the countdown timer in your tracking modal.`;
    else if (q.includes('pdf') || q.includes('upload') || q.includes('file'))
      res = `📄 Upload any PDF in the <strong>Place Order</strong> tab — we auto-count pages and calculate cost!`;
    else if (q.includes('hello') || q.includes('hi') || q.includes('hey'))
      res = `Hi there! 😊 How can I help you with your print delivery today?`;
    else
      res = `Thank you for contacting PrintIt! A support agent will connect shortly. 🎧`;
    addAgent(res);
  }
}

/* ============================================================
   SYSTEM AUDIT LOGS
============================================================ */
function addSystemLog(text, type = 'info') {
  // Write to Firestore — listener updates S.logs and the admin UI
  fsAddLog(text, type);
}

function renderAdminLogs() {
  const container = $('adm-system-logs');
  if (!container) return;
  if (!S.logs || S.logs.length === 0) {
    container.innerHTML = `<div style="font-size:0.8rem;color:var(--txt3);text-align:center;padding:12px;">No activity logs yet</div>`;
    return;
  }
  container.innerHTML = S.logs.map(l => {
    const cls = l.type === 'success' ? 'log-success' : (l.type === 'error' ? 'log-error' : (l.type === 'warning' ? 'log-warning' : 'log-info'));
    return `<div class="admin-log-item ${cls}">
      <span style="font-size:0.72rem;color:var(--txt3);float:right;">${new Date(l.time).toLocaleTimeString()}</span>
      ${esc(l.text)}
    </div>`;
  }).join('');
}

/* ============================================================
   ADMIN PANEL
============================================================ */
function initAdminPanel() {
  qsa('[data-admin-tab]').forEach(btn => {
    btn.onclick = () => {
      qsa('[data-admin-tab]').forEach(b => b.classList.remove('active'));
      qsa('.admin-tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.adminTab;
      $('adminpanel-' + tab).classList.add('active');
      $('admin-panel-title').textContent = btn.textContent.trim().substring(2) + ' Management';
      renderAdminTabContent(tab);
    };
  });

  $('btn-switch-to-user').onclick = () => {
    initDashboard();
    showView('view-dashboard');
    toast('👥 Switched to Customer View', 'success');
  };

  $('btn-admin-logout').onclick = async () => {
    detachListeners();
    S.user = null; S.orders = [];
    await auth.signOut();
    showView('view-login');
    $('login-email').value = ''; $('login-password').value = '';
    toast('Logged out from Admin', 'info');
  };

  $('btn-save-pricing').onclick = async () => {
    S.pricing.color  = parseFloat($('adm-prc-color').value)  || 10;
    S.pricing.bw     = parseFloat($('adm-prc-bw').value)     || 2;
    S.pricing.single = parseFloat($('adm-prc-single').value) || 2;
    S.pricing.double = parseFloat($('adm-prc-double').value) || 1.5;
    S.pricing.a3     = parseFloat($('adm-prc-a3').value)     || 5;
    S.pricing.spiral = parseFloat($('adm-prc-spiral').value) || 40;
    S.pricing.book   = parseFloat($('adm-prc-book').value)   || 60;
    try {
      await fsWriteConfig('pricing', S.pricing);
      addSystemLog('Pricing rates updated by admin', 'warning');
      toast('💰 Pricing saved!', 'success');
    } catch(e) { toast('Failed to save pricing.', 'error'); }
  };

  $('btn-create-coupon').onclick = async () => {
    const code     = $('adm-cpn-code').value.trim().toUpperCase();
    const discount = parseInt($('adm-cpn-discount').value, 10);
    const min      = parseFloat($('adm-cpn-min').value) || 0;
    if (!code || isNaN(discount) || discount < 1 || discount > 100) {
      toast('Please enter valid coupon details (1–100% discount)', 'error'); return;
    }
    if (S.coupons.some(c => c.code.toUpperCase() === code)) {
      toast('Coupon code already exists', 'error'); return;
    }
    try {
      await db.collection('coupons').doc(code).set({ code, discount, minAmount: min });
      addSystemLog(`Coupon created: ${code} (${discount}% off)`, 'success');
      toast(`🎟️ Coupon ${code} created!`, 'success');
      $('adm-cpn-code').value = ''; $('adm-cpn-discount').value = ''; $('adm-cpn-min').value = '';
    } catch(e) { toast('Failed to create coupon.', 'error'); }
  };

  $('btn-save-settings').onclick = async () => {
    S.simSpeed     = parseInt($('adm-set-speed').value, 10) || 1;
    S.supportAgent = $('adm-set-agent').value.trim() || 'Priya';
    try {
      await fsWriteConfig('settings', { simSpeed: S.simSpeed, supportAgent: S.supportAgent });
      addSystemLog(`Settings updated — sim speed: ${S.simSpeed}x`, 'warning');
      toast('⚙️ Settings saved!', 'success');
    } catch(e) { toast('Failed to save settings.', 'error'); }
  };

  renderAdminTabContent('dashboard');
}

function renderAdminTabContent(tab) {
  if (tab === 'dashboard') {
    const rev   = S.orders.reduce((s, o) => s + (o.price || 0), 0);
    const active= S.orders.filter(o => o.status === 'active').length;
    $('adm-stat-revenue').textContent = `₹ ${rev}`;
    $('adm-stat-active').textContent  = active;
    $('adm-stat-queue').textContent   = active;

    db.collection('users').where('role','==','customer').get()
      .then(snap => { if ($('adm-stat-users')) $('adm-stat-users').textContent = snap.size; })
      .catch(() => {});

    const container = $('adm-recent-orders-list');
    const recent    = S.orders.slice(0, 5);
    container.innerHTML = recent.length === 0
      ? `<div style="font-size:0.85rem;color:var(--txt3);text-align:center;padding:20px;">No orders placed yet</div>`
      : recent.map(o => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:0.85rem;">
            <div><strong>${o.id}</strong> – <span style="color:var(--txt2);">${esc(o.fileName)}</span></div>
            <span style="font-weight:700;color:var(--txt);">₹ ${o.price}</span>
          </div>`).join('');
    renderAdminLogs();
  }
  else if (tab === 'orders') {
    renderAdminOrdersTable();
    $('adm-orders-search').oninput = e => renderAdminOrdersTable(e.target.value.trim().toLowerCase());
  }
  else if (tab === 'customers') { renderAdminCustomersTable(); }
  else if (tab === 'queue')     { renderAdminPrintQueue(); }
  else if (tab === 'delivery')  { renderAdminDeliveryRuns(); }
  else if (tab === 'pricing') {
    $('adm-prc-color').value  = S.pricing.color  || 10;
    $('adm-prc-bw').value     = S.pricing.bw     || 2;
    $('adm-prc-single').value = S.pricing.single || 2;
    $('adm-prc-double').value = S.pricing.double || 1.5;
    $('adm-prc-a3').value     = S.pricing.a3     || 5;
    $('adm-prc-spiral').value = S.pricing.spiral || 40;
    $('adm-prc-book').value   = S.pricing.book   || 60;
  }
  else if (tab === 'coupons')   { renderAdminCoupons(); }
  else if (tab === 'analytics') {
    const total    = S.orders.length || 1;
    const clrCount = S.orders.filter(o => o.color === 'color').length;
    const clrPct   = Math.round((clrCount / total) * 100);
    const bwPct    = 100 - clrPct;
    $('adm-anal-color-bar').style.width = clrPct + '%';
    $('adm-anal-color-val').textContent = clrPct + '%';
    $('adm-anal-bw-bar').style.width    = bwPct + '%';
    $('adm-anal-bw-val').textContent    = bwPct + '%';
    const delCount  = S.orders.filter(o => o.status === 'delivered').length;
    $('adm-anal-fulfillment').textContent = Math.round((delCount / total) * 100) + '%';
  }
  else if (tab === 'inventory') { renderAdminInventory(); }
  else if (tab === 'settings') {
    $('adm-set-speed').value = S.simSpeed     || 1;
    $('adm-set-agent').value = S.supportAgent || 'Priya';
  }
}

function renderAdminOrdersTable(query = '') {
  const tbody = $('adm-orders-table').querySelector('tbody');
  if (!tbody) return;

  let list = S.orders;
  if (query) list = list.filter(o =>
    o.id.toLowerCase().includes(query) ||
    o.fileName.toLowerCase().includes(query) ||
    (o.username || '').toLowerCase().includes(query)
  );

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--txt3);padding:32px;">No matching orders found</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(o => {
    const isAct = o.status === 'active';
    let action  = `<span style="font-size:0.8rem;color:var(--txt3);font-style:italic;">No actions</span>`;

    if (isAct) {
      const rem = getRemaining(o);
      const pct = ((o.deliSec - rem) / o.deliSec) * 100;
      let lbl   = 'Print Complete';
      if (pct >= 25 && pct < 55) lbl = 'Pack Document';
      else if (pct >= 55)        lbl = 'Dispatch Courier';
      action = `<div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="admin-action-btn btn-approve" onclick="admAdvanceOrder('${o.id}')">${lbl}</button>
        <button class="admin-action-btn btn-cancel"  onclick="admCancelOrder('${o.id}')">Cancel</button>
      </div>`;
    }

    const badgeStyle = o.status === 'delivered'
      ? 'background:#f0fff4;color:var(--green-dk);border:1px solid rgba(76,175,80,.2);'
      : (o.status === 'cancelled' ? 'background:#fee2e2;color:#ef4444;border:1px solid #fee2e2;'
      : 'background:#fff3f3;color:var(--red);border:1px solid rgba(28,118,143,.2);');
    const badgeLbl = o.status === 'delivered' ? 'Delivered' : (o.status === 'cancelled' ? 'Cancelled' : 'Active');

    return `
      <tr>
        <td style="font-weight:700;color:var(--txt);">${o.id}</td>
        <td><strong>${esc(o.fileName)}</strong><br>
          <span style="font-size:0.76rem;color:var(--txt2);">${o.color === 'color' ? 'Color' : 'B&W'} • ${o.copies} copies • ${o.pageSize}</span></td>
        <td><strong>${esc(o.username || 'user')}</strong><br>
          <span style="font-size:0.74rem;color:var(--txt3);">${esc(o.address)}</span></td>
        <td style="font-weight:700;color:var(--txt);">₹ ${o.price}</td>
        <td><span class="status-badge" style="display:inline-flex;${badgeStyle}">${badgeLbl}</span></td>
        <td>${action}</td>
      </tr>`;
  }).join('');
}

window.admAdvanceOrder = async function(id) {
  const order = S.orders.find(o => o.id === id);
  if (!order) return;
  const elapsed    = Math.floor((Date.now() - order.placedAt) / 1000) * (S.simSpeed || 1);
  const rem        = Math.max(0, order.deliSec - elapsed);
  const currentPct = (order.deliSec - rem) / order.deliSec;

  if (currentPct >= 0.55) {
    await completeOrder(id);
    addSystemLog(`Admin completed delivery manually: ${id}`, 'success');
    const btn = qs('.admin-menu-btn.active');
    if (btn) renderAdminTabContent(btn.dataset.adminTab);
    return;
  }

  const shift      = currentPct < 0.25
    ? Math.round(order.deliSec * 0.26) - (order.deliSec - rem)
    : Math.round(order.deliSec * 0.56) - (order.deliSec - rem);
  const newPlacedAt= order.placedAt - (shift * 1000) / (S.simSpeed || 1);
  order.placedAt   = newPlacedAt;

  try {
    await fsUpdateOrder(id, { placedAt: newPlacedAt });
    addSystemLog(`Admin advanced status of order ${id}`, 'info');
  } catch(e) { console.error('admAdvanceOrder error:', e); }

  const btn = qs('.admin-menu-btn.active');
  if (btn) renderAdminTabContent(btn.dataset.adminTab);
};

window.admCancelOrder = async function(id) {
  const order = S.orders.find(o => o.id === id);
  if (!order) return;
  order.status = 'cancelled';
  if (S.timers[id]) { clearInterval(S.timers[id]); delete S.timers[id]; }
  try {
    await fsUpdateOrder(id, { status: 'cancelled' });
    addSystemLog(`Admin cancelled order: ${id}`, 'error');
  } catch(e) { console.error('admCancelOrder error:', e); }
  updateBadge();
  toast(`❌ Order ${id} cancelled`, 'info');
  const btn = qs('.admin-menu-btn.active');
  if (btn) renderAdminTabContent(btn.dataset.adminTab);
};

function renderAdminCustomersTable() {
  const tbody = $('adm-customers-table').querySelector('tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--txt3);padding:20px;">Loading customers…</td></tr>`;

  db.collection('users').where('role','==','customer').get()
    .then(snap => {
      if (snap.empty) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--txt3);padding:32px;">No customers registered yet</td></tr>`;
        return;
      }
      tbody.innerHTML = snap.docs.map(doc => {
        const u    = doc.data();
        const dUid = doc.id;
        const tot  = S.orders.filter(o => o.uid === dUid || o.username === u.username).length;
        const btn  = u.active
          ? `<button class="admin-action-btn btn-cancel" onclick="admToggleCustomer('${dUid}',false)">Suspend Account</button>`
          : `<button class="admin-action-btn btn-approve" onclick="admToggleCustomer('${dUid}',true)">Activate Account</button>`;
        return `
          <tr>
            <td style="font-weight:700;color:var(--txt);">${esc(u.username)}</td>
            <td>${esc(u.email || '')}<br><span style="font-size:0.76rem;color:var(--txt3);">${u.phone ? '📱 '+esc(u.phone) : ''}</span></td>
            <td style="font-weight:700;">${tot}</td>
            <td>${new Date(u.joined || Date.now()).toLocaleDateString('en-IN')}</td>
            <td><span class="status-badge" style="display:inline-flex;${u.active ? 'background:#eafaf1;color:var(--green);' : 'background:#fee2e2;color:#ef4444;'}">
              ${u.active ? 'Active' : 'Suspended'}</span></td>
            <td style="text-align:right;">${btn}</td>
          </tr>`;
      }).join('');
    })
    .catch(err => {
      console.error('renderAdminCustomersTable error:', err);
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--txt3);padding:20px;">Failed to load customers</td></tr>`;
    });
}

window.admToggleCustomer = async function(userUid, activate) {
  try {
    await db.collection('users').doc(userUid).update({ active: activate });
    addSystemLog(`Customer ${userUid} ${activate ? 'activated' : 'suspended'}`, 'warning');
    toast(`👤 Customer ${activate ? 'activated' : 'suspended'}!`, 'success');
    renderAdminCustomersTable();
  } catch(e) { toast('Failed to update customer status.', 'error'); }
};

function renderAdminPrintQueue() {
  const activeJobs = S.orders.filter(o => o.status === 'active');
  const activeDiv  = $('adm-active-printing-job');
  const queueDiv   = $('adm-print-queue-list');

  if (activeJobs.length === 0) {
    activeDiv.innerHTML = `<div style="font-size:0.85rem;color:var(--txt3);border:2px dashed var(--border);text-align:center;padding:24px;border-radius:var(--r-md);">No documents currently printing</div>`;
    queueDiv.innerHTML  = ''; return;
  }

  const cur = activeJobs[0];
  const rem = getRemaining(cur);
  const pct = Math.round(((cur.deliSec - rem) / cur.deliSec) * 100);

  activeDiv.innerHTML = `
    <div style="background:#fafafa;border:1px solid var(--border);padding:18px;border-radius:var(--r-md);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
        <div>
          <strong style="color:var(--txt);">${esc(cur.fileName)}</strong>
          <div style="font-size:0.76rem;color:var(--txt2);margin-top:2px;">Order: ${cur.id} • ${cur.copies} copies • ${cur.color === 'color' ? '🎨 Color' : '⬛ B&W'}</div>
        </div>
        <span style="font-size:0.74rem;background:var(--red-bg);color:var(--red);padding:4px 10px;border-radius:50px;font-weight:700;text-transform:uppercase;">Active Print</span>
      </div>
      <div style="font-size:0.8rem;color:var(--txt2);display:flex;justify-content:space-between;margin-bottom:6px;">
        <span>Spool progress: ${pct}%</span><span>${fmtTime(rem)} remaining</span>
      </div>
      <div style="height:8px;background:#e2e8f0;border-radius:50px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:var(--red);border-radius:50px;transition:width 1s linear;"></div>
      </div>
    </div>`;

  const rest = activeJobs.slice(1);
  queueDiv.innerHTML = rest.length === 0
    ? `<div style="font-size:0.8rem;color:var(--txt3);text-align:center;padding:10px;">Queue empty</div>`
    : rest.map(o => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;background:white;border:1px solid var(--border);border-radius:var(--r-sm);font-size:0.85rem;">
          <div>
            <strong>${esc(o.fileName)}</strong>
            <div style="font-size:0.74rem;color:var(--txt3);margin-top:2px;">${o.copies} copies • ${o.id}</div>
          </div>
          <span style="font-size:0.72rem;background:#eef2ff;color:#4f46e5;padding:2px 8px;border-radius:50px;font-weight:700;">QUEUED</span>
        </div>`).join('');
}

function renderAdminDeliveryRuns() {
  const runs      = S.orders.filter(o => o.status === 'active');
  const container = $('adm-delivery-runs-list');
  if (runs.length === 0) {
    container.innerHTML = `<div style="font-size:0.85rem;color:var(--txt3);border:2px dashed var(--border);text-align:center;padding:24px;border-radius:var(--r-md);">No delivery runs in progress</div>`;
    return;
  }
  container.innerHTML = runs.map((o, idx) => {
    const rem = getRemaining(o);
    const pct = Math.round(((o.deliSec - rem) / o.deliSec) * 100);
    return `
      <div style="background:#fafafa;border:1px solid var(--border);padding:16px;border-radius:var(--r-md);font-size:0.88rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <strong>🛵 Scooter #${(idx % 2) + 1} Dispatch</strong>
          <span style="font-size:0.74rem;font-weight:700;color:var(--red);">${fmtTime(rem)} left</span>
        </div>
        <div style="font-size:0.78rem;color:var(--txt2);margin-bottom:8px;">Order: ${o.id} &nbsp;•&nbsp; Dest: <strong style="color:var(--txt);">${esc(o.address)}</strong></div>
        <div style="position:relative;height:16px;display:flex;align-items:center;background:#e2e8f0;border-radius:50px;overflow:hidden;padding:0 4px;">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,var(--red),var(--red-lt));border-radius:50px;"></div>
          <span style="position:absolute;left:calc(${pct}% - 14px);font-size:1.1rem;transition:left 1s linear;">🛵</span>
        </div>
      </div>`;
  }).join('');
}

function renderAdminCoupons() {
  const container = $('adm-coupons-list');
  if (!container) return;
  if (S.coupons.length === 0) {
    container.innerHTML = `<div style="font-size:0.85rem;color:var(--txt3);grid-column:span 2;text-align:center;padding:20px;">No coupons defined</div>`;
    return;
  }
  container.innerHTML = S.coupons.map(c => `
    <div class="card" style="padding:14px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
      <div>
        <strong style="color:var(--txt);font-size:0.95rem;">${c.code}</strong>
        <div style="font-size:0.74rem;color:var(--txt2);margin-top:2px;">${c.discount}% Discount • Min: ₹${c.minAmount || 0}</div>
      </div>
      <button class="admin-action-btn btn-cancel" onclick="admDeleteCoupon('${c.code}')">Delete</button>
    </div>`).join('');
}

window.admDeleteCoupon = async function(code) {
  try {
    await db.collection('coupons').doc(code).delete();
    addSystemLog(`Coupon deleted: ${code}`, 'warning');
    toast(`🎟️ Coupon ${code} deleted`, 'info');
    // onSnapshot updates S.coupons automatically
  } catch(e) { toast('Failed to delete coupon.', 'error'); }
};

function renderAdminInventory() {
  const container = $('adm-inventory-grid');
  if (!container) return;
  container.innerHTML = Object.entries(S.inventory).map(([key, item]) => {
    const pct = Math.round((item.count / item.max) * 100);
    const low = pct <= 20;
    return `
      <div class="inv-card">
        <div style="flex:1;">
          <strong style="color:var(--txt);display:block;margin-bottom:2px;">${item.name}</strong>
          <span style="font-size:0.74rem;color:var(--txt2);">${item.count} / ${item.max} ${item.unit} (${pct}%)</span>
          <div style="height:6px;background:#e2e8f0;border-radius:50px;margin-top:8px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${low ? '#ef4444' : item.fill};border-radius:50px;"></div>
          </div>
        </div>
        <button class="admin-action-btn btn-approve" onclick="admRestockItem('${key}')" style="margin-left:16px;">Restock</button>
      </div>`;
  }).join('');
}

window.admRestockItem = async function(key) {
  const item = S.inventory[key];
  if (!item) return;
  item.count = item.max;
  try {
    await fsWriteConfig('inventory', S.inventory);
    addSystemLog(`Inventory restocked: ${item.name}`, 'success');
    toast(`📦 ${item.name} fully restocked!`, 'success');
    renderAdminInventory();
  } catch(e) { toast('Failed to restock. Check connection.', 'error'); }
};

/* ============================================================
   BOOT  —  onAuthStateChanged drives all navigation
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initFilters();
  initPayment();
  initSupport();
  showView('view-login');   // Default while waiting for auth

  auth.onAuthStateChanged(async (fbUser) => {
    // Reset button states in case of re-trigger
    const loginBtn = $('btn-login-submit');
    const regBtn   = $('btn-register-submit');
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Login'; }
    if (regBtn)   { regBtn.disabled   = false; regBtn.textContent   = 'Create Account'; }

    if (!fbUser) {
      S.user = null; S.orders = [];
      Object.values(S.timers).forEach(clearInterval);
      S.timers = {};
      detachListeners();
      showView('view-login');
      return;
    }

    try {
      // ── Load user profile ───────────────────────────────
      const userDoc = await db.collection('users').doc(fbUser.uid).get();
      if (userDoc.exists) {
        S.user = { uid: fbUser.uid, ...userDoc.data() };
      } else {
        // First-ever login (e.g. admin@printit.in created in Console)
        const isAdmin = fbUser.email === 'admin@printit.in';
        S.user = {
          uid:      fbUser.uid,
          username: isAdmin ? 'admin' : (fbUser.displayName || fbUser.email.split('@')[0]),
          email:    fbUser.email,
          role:     isAdmin ? 'admin' : 'customer',
          joined:   Date.now(),
          active:   true
        };
        await db.collection('users').doc(fbUser.uid).set(S.user);
      }

      // ── Suspended account check ─────────────────────────
      if (!S.user.active && S.user.role !== 'admin') {
        await auth.signOut();
        toast('🚫 Your account has been suspended by Admin', 'error');
        showView('view-login');
        return;
      }

      // ── Seed defaults & attach real-time listeners ───────
      await seedInitialDataIfNeeded();
      listenAll(fbUser.uid, S.user.role === 'admin');

      // ── Navigate ─────────────────────────────────────────
      if (S.user.role === 'admin') {
        initAdminPanel();
        showView('view-admin');
        toast('🔑 Welcome back, Admin!', 'success');
      } else {
        initDashboard();
        showView('view-dashboard');
        toast(`🎉 Welcome back, ${S.user.username || 'User'}!`, 'success');
      }
    } catch(err) {
      console.error('onAuthStateChanged error:', err);
      toast('Failed to load your profile. Please try again.', 'error');
      await auth.signOut();
      showView('view-login');
    }
  });
});
