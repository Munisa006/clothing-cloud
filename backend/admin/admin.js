'use strict';

// Operations console logic. Authenticates against /api/admin/login, keeps the
// token in sessionStorage (so a page refresh does not force a re-login within
// the tab), and drives the dashboard, catalogue and order views by calling the
// protected admin API.

const TOKEN_KEY = 'meridian_admin_token';
let token = sessionStorage.getItem(TOKEN_KEY) || null;
let me = null; // { id, name, username, role }

const DEMO_USERS = {
  admin: { username: 'admin', password: 'admin123' },
  manager: { username: 'manager', password: 'manager123' },
  erp_mgr: { username: 'erp_mgr', password: 'erp123' },
  crm_mgr: { username: 'crm_mgr', password: 'crm123' },
  wms_mgr: { username: 'wms_mgr', password: 'wms123' },
  sales: { username: 'sales', password: 'sales123' },
  warehouse: { username: 'warehouse', password: 'warehouse123' },
  viewer: { username: 'viewer', password: 'viewer123' },
};

const ROLE_RANK = { 
  viewer: 0,
  staff: 1,
  warehouse_staff: 1,
  sales_rep: 1,
  crm_manager: 2,
  wms_manager: 2,
  manager: 2,
  erp_manager: 3,
  admin: 3
};
const ROLE_LABELS = { 
  viewer: 'Viewer',
  staff: 'Staff',
  warehouse_staff: 'Warehouse Staff',
  sales_rep: 'Sales Rep',
  crm_manager: 'CRM Manager',
  wms_manager: 'WMS Manager',
  manager: 'Manager',
  erp_manager: 'ERP Manager',
  admin: 'Admin'
};
const can = (minRole) => (ROLE_RANK[me && me.role] || 0) >= (ROLE_RANK[minRole] || 99);

// Build initials for the avatar (e.g. "Jane Doe" → "JD").
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('').toUpperCase() || '··';
}

// Show/hide elements tagged with data-role-min based on the signed-in role.
function applyRoleVisibility() {
  document.querySelectorAll('[data-role-min]').forEach((el) => {
    el.hidden = !can(el.dataset.roleMin);
  });
}

const $ = (id) => document.getElementById(id);
const money = (n) => '$' + Number(n).toFixed(2);
const drawIcons = () => { if (window.lucide) window.lucide.createIcons(); };

// Escape DB-supplied text before interpolating into innerHTML.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Category → representative product photo (Unsplash). Mirrors the storefront.
const CATEGORY_IMAGES = {
  'T-Shirts': 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=200&q=60',
  'Hoodies': 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=200&q=60',
  'Denim': 'https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=200&q=60',
  'Jackets': 'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=200&q=60',
  'Accessories': 'https://images.unsplash.com/photo-1576871337622-98d48d1cf531?auto=format&fit=crop&w=200&q=60',
};
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?auto=format&fit=crop&w=200&q=60';
const imageFor = (p) => (p && p.image_url) || CATEGORY_IMAGES[p && p.category] || FALLBACK_IMAGE;

const LOW_STOCK_THRESHOLD = 100;
const PAGE_SIZE = 10;
const paging = { products: 1, orders: 1 };

// Build a pager control. `onGo(page)` is called when a page button is clicked.
function renderPager(meta, onGo) {
  if (!meta || meta.pages <= 1) return null;
  const { page, pages, total, limit } = meta;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const el = document.createElement('div');
  el.className = 'pager';
  el.innerHTML = `
    <span class="pager-info">${from}–${to} of ${total}</span>
    <div class="pager-btns">
      <button type="button" class="pager-btn" data-go="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page"><i data-lucide="chevron-left"></i></button>
      <span class="pager-page">Page ${page} of ${pages}</span>
      <button type="button" class="pager-btn" data-go="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page"><i data-lucide="chevron-right"></i></button>
    </div>`;
  el.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => onGo(parseInt(b.dataset.go, 10))));
  return el;
}

function mountPager(containerId, meta, onGo) {
  const container = $(containerId);
  container.innerHTML = '';
  const pager = renderPager(meta, onGo);
  if (pager) { container.appendChild(pager); drawIcons(); }
}
function renderProductsPager(data) {
  mountPager('productsPager', data, (p) => { paging.products = p; loadProducts(); });
}
function renderOrdersPager(data) {
  mountPager('ordersPager', data, (p) => { paging.orders = p; loadOrders(); });
}
const STATUS_ICONS = { received: 'inbox', processing: 'loader', dispatched: 'truck', cancelled: 'x-circle' };
const STATUS_LABELS = { received: 'Received', processing: 'Processing', dispatched: 'Dispatched', cancelled: 'Cancelled' };

// --- Toast notifications ---
function toast(message, type = 'info') {
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const icon = type === 'error' ? 'alert-circle' : type === 'success' ? 'check-circle' : 'info';
  el.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span>${esc(message)}</span>`;
  stack.appendChild(el);
  drawIcons();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3600);
}

// --- API helper that attaches the admin token ---
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(options.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error('Your session has expired — please sign in again.'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- Login / logout ---
function enterConsole() {
  // Populate the user menu from the signed-in profile.
  $('userAvatar').textContent = initials(me.name);
  $('userName').textContent = me.name;
  $('userRole').textContent = ROLE_LABELS[me.role] || me.role;
  $('userRole').className = 'role-badge role-' + me.role;
  $('popName').textContent = me.name;
  $('popUsername').textContent = '@' + me.username;
  applyRoleVisibility();
  $('loginScreen').hidden = true;
  $('console').hidden = false;
  drawIcons();
  showView('dashboard');
}

// Load the signed-in user's profile; returns false if the token is invalid.
async function loadMe() {
  me = await api('/api/admin/me');
  sessionStorage.setItem('meridian_admin_me', JSON.stringify(me));
  return me;
}

document.querySelectorAll('[data-demo-user]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const demoUser = btn.dataset.demoUser;
    const creds = DEMO_USERS[demoUser];
    if (creds) {
      $('username').value = creds.username;
      $('password').value = creds.password;
      $('loginError').textContent = '';
      [$('username'), $('password')].forEach((el) => {
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 600);
      });
      $('loginBtn').focus();
    }
  });
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) {
    $('loginError').textContent = 'Please enter both a username and password.';
    return;
  }
  const btn = $('loginBtn');
  btn.disabled = true; btn.classList.add('loading');
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed');
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    await loadMe();
    $('loginForm').reset();
    enterConsole();
  } catch (err) {
    $('loginError').textContent = err.message;
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
  }
});

function logout() {
  token = null; me = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem('meridian_admin_me');
  closeUserMenu();
  $('console').hidden = true;
  $('loginScreen').hidden = false;
  $('loginForm').reset();
}
$('logoutBtn').addEventListener('click', logout);

// --- User menu (avatar dropdown) ---
function openUserMenu() { $('userMenuPop').hidden = false; $('userMenuBtn').setAttribute('aria-expanded', 'true'); }
function closeUserMenu() { $('userMenuPop').hidden = true; $('userMenuBtn').setAttribute('aria-expanded', 'false'); }
$('userMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('userMenuPop').hidden ? openUserMenu() : closeUserMenu();
});
document.addEventListener('click', (e) => {
  if (!$('userMenu').contains(e.target)) closeUserMenu();
});

// --- Mobile nav toggle ---
$('navToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));

// --- View switching ---
document.querySelectorAll('.nav-btn').forEach((btn) =>
  btn.addEventListener('click', () => showView(btn.dataset.view)));

const VIEW_LABELS = { 
  dashboard: 'Dashboard', 
  products: 'Catalogue', 
  orders: 'Orders',
  customers: 'Customers',
  interactions: 'Interactions',
  warehouses: 'Warehouses',
  inventory: 'Inventory',
  'stock-movements': 'Stock Movements',
  'purchase-orders': 'Purchase Orders',
  reports: 'Reports',
  users: 'Users' 
};
function showView(view) {
  // Guard: only admins may open the Users view.
  if (view === 'users' && !can('admin')) view = 'dashboard';
  // Guard: CRM views require crm_manager or higher
  if (['customers', 'interactions'].includes(view) && !can('crm_manager')) view = 'dashboard';
  // Guard: WMS views require wms_manager or higher
  if (['warehouses', 'inventory', 'stock-movements'].includes(view) && !can('wms_manager')) view = 'dashboard';
  // Guard: ERP views require erp_manager or higher
  if (['purchase-orders', 'reports'].includes(view) && !can('erp_manager')) view = 'dashboard';
  
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  $('crumbCurrent').textContent = VIEW_LABELS[view] || view;
  $('sidebar').classList.remove('open');
  
  if (view === 'dashboard') loadDashboard();
  if (view === 'products') loadProducts();
  if (view === 'orders') loadOrders();
  if (view === 'customers') loadCustomers();
  if (view === 'interactions') loadInteractions();
  if (view === 'warehouses') loadWarehouses();
  if (view === 'inventory') loadInventory();
  if (view === 'stock-movements') loadStockMovements();
  if (view === 'purchase-orders') loadPurchaseOrders();
  if (view === 'reports') loadReports();
  if (view === 'users') loadUsers();
}

// --- Dashboard ---
async function loadDashboard() {
  const gridEl = $('statGrid');
  gridEl.innerHTML = Array.from({ length: 5 }, () => '<div class="stat stat-skeleton"><span class="skeleton"></span></div>').join('');
  try {
    const s = await api('/api/admin/summary');
    gridEl.innerHTML = [
      stat('Products', s.products, '', 'package'),
      stat('Low stock', s.lowStock, s.lowStock > 0 ? 'warn' : '', 'alert-triangle', `Under ${LOW_STOCK_THRESHOLD} units`),
      stat('Total orders', s.orders, '', 'receipt'),
      stat('Open orders', s.openOrders, '', 'clock', 'Received or processing'),
      stat('Revenue', money(s.revenue), '', 'dollar-sign', 'Excludes cancelled'),
    ].join('');
    drawIcons();
  } catch (err) {
    gridEl.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}
function stat(label, value, cls = '', icon = 'circle', hint = '') {
  return `<div class="stat">
    <div class="stat-icon"><i data-lucide="${icon}" aria-hidden="true"></i></div>
    <div class="label">${esc(label)}</div>
    <div class="value ${cls}">${value}</div>
    ${hint ? `<div class="stat-hint">${esc(hint)}</div>` : ''}
  </div>`;
}

// --- Products ---
async function loadProducts() {
  const tbody = document.querySelector('#productsTable tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="cell-state">Loading catalogue…</td></tr>';
  try {
    const data = await api(`/api/admin/products?page=${paging.products}&limit=${PAGE_SIZE}`);
    const products = data.items;
    // If we deleted the last row on a page, step back a page and retry.
    if (!products.length && data.page > 1) { paging.products = data.page - 1; return loadProducts(); }
    renderProductsPager(data);
    if (!products.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="cell-state">
        <div class="empty-block"><i data-lucide="package-open" aria-hidden="true"></i>
        <p>No products yet. Add your first product to start the catalogue.</p></div></td></tr>`;
      drawIcons();
      return;
    }
    tbody.innerHTML = '';
    for (const p of products) {
      const tr = document.createElement('tr');
      const low = p.stock < LOW_STOCK_THRESHOLD;
      tr.innerHTML = `
        <td><img class="cell-thumb" src="${imageFor(p)}" alt=""
              onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" /></td>
        <td class="mono">${esc(p.sku)}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.category)}</td>
        <td>${money(p.unit_price)}</td>
        <td>${p.moq}</td>
        <td class="${low ? 'stock-low' : ''}">${p.stock}${low ? ' <i data-lucide="alert-triangle" aria-hidden="true"></i>' : ''}</td>
        <td class="row-actions">
          <button type="button" class="edit" aria-label="Edit ${esc(p.name)}" title="Edit"><i data-lucide="pencil" aria-hidden="true"></i></button>
          <button type="button" class="del" aria-label="Delete ${esc(p.name)}" title="Delete"><i data-lucide="trash-2" aria-hidden="true"></i></button>
        </td>`;
      tr.querySelector('.edit').addEventListener('click', () => openProductModal(p));
      tr.querySelector('.del').addEventListener('click', () => deleteProduct(p));
      tbody.appendChild(tr);
    }
    drawIcons();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="cell-state">${esc(err.message)}</td></tr>`;
  }
}

async function deleteProduct(p) {
  const ok = await confirmDialog({
    title: 'Delete product',
    body: `Delete “${p.name}” (${p.sku})? This cannot be undone.`,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api('/api/admin/products/' + p.id, { method: 'DELETE' });
    toast(`Deleted “${p.name}”.`, 'success');
    loadProducts();
  } catch (err) { toast(err.message, 'error'); }
}

// --- Product modal ---
let modalLastFocused = null;
$('addProductBtn').addEventListener('click', () => openProductModal(null));
$('cancelModal').addEventListener('click', closeModal);

function openProductModal(p) {
  modalLastFocused = document.activeElement;
  $('modalError').textContent = '';
  $('modalTitle').textContent = p ? 'Edit product' : 'New product';
  $('p-id').value = p ? p.id : '';
  $('p-sku').value = p ? p.sku : '';
  $('p-sku').disabled = !!p; // SKU is immutable once created
  $('p-name').value = p ? p.name : '';
  $('p-category').value = p ? p.category : '';
  $('p-price').value = p ? p.unit_price : '';
  $('p-moq').value = p ? p.moq : 1;
  $('p-stock').value = p ? p.stock : 0;
  $('p-image').value = p && p.image_url ? p.image_url : '';
  updateImgPreview();
  $('modalOverlay').hidden = false;
  document.body.classList.add('no-scroll');
  drawIcons();
  (p ? $('p-name') : $('p-sku')).focus();
}
function closeModal() {
  $('modalOverlay').hidden = true;
  document.body.classList.remove('no-scroll');
  if (modalLastFocused && modalLastFocused.focus) modalLastFocused.focus();
}

// Live preview of the entered image URL (or the category fallback).
function updateImgPreview() {
  const url = $('p-image').value.trim();
  const wrap = $('imgPreview');
  const el = $('imgPreviewEl');
  const cat = $('p-category').value.trim();
  const src = url || CATEGORY_IMAGES[cat] || '';
  if (!src) { wrap.hidden = true; return; }
  el.src = src;
  el.onerror = () => { wrap.hidden = true; };
  wrap.hidden = false;
}
$('p-image').addEventListener('input', updateImgPreview);
$('p-category').addEventListener('input', updateImgPreview);

$('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('modalError').textContent = '';
  const id = $('p-id').value;

  // Client-side validation with clear messages.
  const sku = $('p-sku').value.trim();
  const name = $('p-name').value.trim();
  const category = $('p-category').value.trim();
  const price = parseFloat($('p-price').value);
  const moq = parseInt($('p-moq').value, 10);
  const stock = parseInt($('p-stock').value, 10);
  if (!id && !sku) return setModalError('SKU is required.');
  if (!name) return setModalError('Name is required.');
  if (!category) return setModalError('Category is required.');
  if (!Number.isFinite(price) || price < 0) return setModalError('Enter a valid unit price.');
  if (!Number.isInteger(moq) || moq < 1) return setModalError('MOQ must be at least 1.');
  if (!Number.isInteger(stock) || stock < 0) return setModalError('Stock cannot be negative.');

  const body = { name, category, unit_price: price, moq, stock, image_url: $('p-image').value.trim() };
  const btn = $('saveProductBtn');
  btn.disabled = true; btn.classList.add('loading');
  try {
    if (id) {
      await api('/api/admin/products/' + id, { method: 'PUT', body: JSON.stringify(body) });
      toast(`Updated “${name}”.`, 'success');
    } else {
      body.sku = sku;
      await api('/api/admin/products', { method: 'POST', body: JSON.stringify(body) });
      toast(`Created “${name}”.`, 'success');
    }
    closeModal();
    loadProducts();
  } catch (err) {
    setModalError(err.message);
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
  }
});
function setModalError(msg) { $('modalError').textContent = msg; }

// --- Orders ---
$('statusFilter').addEventListener('change', () => { paging.orders = 1; loadOrders(); });
async function loadOrders() {
  const list = $('ordersList');
  list.innerHTML = '<p class="muted">Loading orders…</p>';
  try {
    const status = $('statusFilter').value;
    const qs = `?page=${paging.orders}&limit=${PAGE_SIZE}` + (status ? '&status=' + encodeURIComponent(status) : '');
    const data = await api('/api/admin/orders' + qs);
    const orders = data.items;
    if (!orders.length && data.page > 1) { paging.orders = data.page - 1; return loadOrders(); }
    renderOrdersPager(data);
    if (!orders.length) {
      list.innerHTML = `<div class="empty-block">
        <i data-lucide="inbox" aria-hidden="true"></i>
        <p>${status ? 'No orders with this status.' : 'No orders yet.'}</p></div>`;
      drawIcons();
      return;
    }
    list.innerHTML = '';
    for (const o of orders) {
      const card = document.createElement('div');
      card.className = 'order-card';
      const items = o.items.map((i) => `<span><i data-lucide="box" aria-hidden="true"></i> ${i.quantity}× ${esc(i.name)}</span>`).join('');
      const date = new Date(o.created_at).toLocaleString();
      card.innerHTML = `
        <div class="order-top">
          <div>
            <div class="order-ref">${esc(o.reference)}</div>
            <div class="order-buyer"><i data-lucide="user" aria-hidden="true"></i> ${esc(o.buyer_name)} · ${esc(o.buyer_email)} · ${esc(date)}</div>
          </div>
          <div class="order-total">${money(o.total)}</div>
        </div>
        <div class="order-items">${items}</div>
        <div class="order-foot">
          <span class="badge-status s-${esc(o.status)}"><i data-lucide="${STATUS_ICONS[o.status] || 'circle'}" aria-hidden="true"></i> ${esc(STATUS_LABELS[o.status] || o.status)}</span>
          <div class="select-wrap order-status-wrap">
            <label class="visually-hidden" for="status-${o.id}">Update status for ${esc(o.reference)}</label>
            <select id="status-${o.id}" data-id="${o.id}" class="status-select">
              ${['received','processing','dispatched','cancelled'].map(
                (s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
            </select>
            <i data-lucide="chevron-down" aria-hidden="true"></i>
          </div>
        </div>`;
      card.querySelector('.status-select').addEventListener('change', (e) => updateStatus(o.id, e.target.value, e.target));
      list.appendChild(card);
    }
    drawIcons();
  } catch (err) {
    list.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function updateStatus(id, status, selectEl) {
  if (selectEl) selectEl.disabled = true;
  try {
    await api('/api/admin/orders/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status }) });
    toast(`Order marked ${STATUS_LABELS[status] || status}.`, 'success');
    loadOrders();
  } catch (err) {
    toast(err.message, 'error');
    if (selectEl) selectEl.disabled = false;
  }
}

// --- Users (admin only) ---
async function loadUsers() {
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="cell-state">Loading users…</td></tr>';
  try {
    const data = await api('/api/admin/users');
    const users = data.items;
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="cell-state">
        <div class="empty-block"><i data-lucide="users" aria-hidden="true"></i>
        <p>No users yet.</p></div></td></tr>`;
      drawIcons();
      return;
    }
    tbody.innerHTML = '';
    for (const u of users) {
      const isSelf = me && u.id === me.id;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><div class="user-cell"><span class="avatar avatar-sm" aria-hidden="true">${esc(initials(u.full_name))}</span>
          <span>${esc(u.full_name)}${isSelf ? ' <span class="you-tag">you</span>' : ''}</span></div></td>
        <td class="mono">@${esc(u.username)}</td>
        <td><span class="role-badge role-${esc(u.role)}">${esc(ROLE_LABELS[u.role] || u.role)}</span></td>
        <td>${u.is_active
          ? '<span class="badge-status s-active"><i data-lucide="check" aria-hidden="true"></i> Active</span>'
          : '<span class="badge-status s-disabled"><i data-lucide="ban" aria-hidden="true"></i> Disabled</span>'}</td>
        <td>${esc(new Date(u.created_at).toLocaleDateString())}</td>
        <td class="row-actions">
          <button type="button" class="edit" aria-label="Edit ${esc(u.full_name)}" title="Edit"><i data-lucide="pencil" aria-hidden="true"></i></button>
          <button type="button" class="del" aria-label="Delete ${esc(u.full_name)}" title="Delete" ${isSelf ? 'disabled' : ''}><i data-lucide="trash-2" aria-hidden="true"></i></button>
        </td>`;
      tr.querySelector('.edit').addEventListener('click', () => openUserModal(u));
      const delBtn = tr.querySelector('.del');
      if (!isSelf) delBtn.addEventListener('click', () => deleteUser(u));
      tbody.appendChild(tr);
    }
    drawIcons();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="cell-state">${esc(err.message)}</td></tr>`;
  }
}

let userModalLastFocused = null;
$('addUserBtn').addEventListener('click', () => openUserModal(null));
$('cancelUserModal').addEventListener('click', closeUserModal);

function openUserModal(u) {
  userModalLastFocused = document.activeElement;
  $('userModalError').textContent = '';
  $('userModalTitle').textContent = u ? 'Edit user' : 'New user';
  $('u-id').value = u ? u.id : '';
  $('u-username').value = u ? u.username : '';
  $('u-username').disabled = !!u; // username is immutable once created
  $('u-fullname').value = u ? u.full_name : '';
  $('u-role').value = u ? u.role : 'staff';
  $('u-active').value = u ? String(u.is_active) : 'true';
  $('u-active').closest('label').hidden = !u; // status only meaningful on edit
  $('u-password').value = '';
  $('u-password-hint').textContent = u ? 'leave blank to keep current password' : 'at least 8 characters';
  $('userModalOverlay').hidden = false;
  document.body.classList.add('no-scroll');
  drawIcons();
  (u ? $('u-fullname') : $('u-username')).focus();
}
function closeUserModal() {
  $('userModalOverlay').hidden = true;
  document.body.classList.remove('no-scroll');
  if (userModalLastFocused && userModalLastFocused.focus) userModalLastFocused.focus();
}

$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('userModalError').textContent = '';
  const id = $('u-id').value;
  const username = $('u-username').value.trim();
  const full_name = $('u-fullname').value.trim();
  const role = $('u-role').value;
  const password = $('u-password').value;

  if (!id && !username) return ($('userModalError').textContent = 'Username is required.');
  if (!full_name) return ($('userModalError').textContent = 'Full name is required.');
  if (!id && password.length < 8) return ($('userModalError').textContent = 'Password must be at least 8 characters.');
  if (id && password && password.length < 8) return ($('userModalError').textContent = 'Password must be at least 8 characters.');

  const btn = $('saveUserBtn');
  btn.disabled = true; btn.classList.add('loading');
  try {
    if (id) {
      const body = { full_name, role, is_active: $('u-active').value === 'true' };
      if (password) body.password = password;
      await api('/api/admin/users/' + id, { method: 'PUT', body: JSON.stringify(body) });
      toast(`Updated “${full_name}”.`, 'success');
    } else {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, full_name, role, password }) });
      toast(`Created “${full_name}”.`, 'success');
    }
    closeUserModal();
    loadUsers();
  } catch (err) {
    $('userModalError').textContent = err.message;
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
  }
});

async function deleteUser(u) {
  const ok = await confirmDialog({
    title: 'Delete user',
    body: `Delete the account for “${u.full_name}” (@${u.username})? This cannot be undone.`,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api('/api/admin/users/' + u.id, { method: 'DELETE' });
    toast(`Deleted “${u.full_name}”.`, 'success');
    loadUsers();
  } catch (err) { toast(err.message, 'error'); }}

// --- CRM: Customers ---
async function loadCustomers() {
  const tbody = document.querySelector('#customersTable tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="cell-state">Loading customers…</td></tr>';
  try {
    const customers = await api('/api/admin/customers');
    if (!customers || customers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="cell-state">No customers found</td></tr>';
      return;
    }
    tbody.innerHTML = customers.map(c => `<tr>
      <td>${esc(c.company_name)}</td>
      <td>${esc(c.contact_name)}</td>
      <td><a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a></td>
      <td>${esc(c.contact_phone || '—')}</td>
      <td><span class="status-badge status-${c.status}">${esc(c.status)}</span></td>
      <td>${money(c.lifetime_value)}</td>
      <td><button type="button" class="icon-btn" title="Edit"><i data-lucide="edit-2"></i></button></td>
    </tr>`).join('');
    drawIcons();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="cell-state muted">${esc(err.message)}</td></tr>`;
  }
}

// --- CRM: Interactions ---
async function loadInteractions() {
  const container = $('interactionsList');
  container.innerHTML = '<p class="cell-state">Loading interactions…</p>';
  try {
    const interactions = await api('/api/admin/interactions');
    if (!interactions || interactions.length === 0) {
      container.innerHTML = '<p class="cell-state">No interactions found</p>';
      return;
    }
    const grouped = interactions.reduce((acc, i) => {
      if (!acc[i.interaction_type]) acc[i.interaction_type] = [];
      acc[i.interaction_type].push(i);
      return acc;
    }, {});
    const html = Object.entries(grouped).map(([type, items]) => `
      <div class="interaction-group">
        <h3>${esc(type.charAt(0).toUpperCase() + type.slice(1))}</h3>
        <div class="interaction-list">
          ${items.map(i => `<div class="interaction-item">
            <div class="interaction-header">
              <strong>${esc(i.subject)}</strong>
              <span class="date">${new Date(i.interaction_date).toLocaleDateString()}</span>
            </div>
            <p>${esc(i.details || '—')}</p>
          </div>`).join('')}
        </div>
      </div>
    `).join('');
    container.innerHTML = html;
    drawIcons();
  } catch (err) {
    container.innerHTML = `<p class="cell-state muted">${esc(err.message)}</p>`;
  }
}

// --- WMS: Warehouses ---
async function loadWarehouses() {
  const tbody = document.querySelector('#warehousesTable tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="cell-state">Loading warehouses…</td></tr>';
  try {
    const warehouses = await api('/api/admin/warehouses');
    if (!warehouses || warehouses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="cell-state">No warehouses found</td></tr>';
      return;
    }
    tbody.innerHTML = warehouses.map(w => {
      const percentage = w.capacity > 0 ? Math.round((w.current_stock / w.capacity) * 100) : 0;
      return `<tr>
        <td>${esc(w.name)}</td>
        <td>${esc(w.location)}</td>
        <td>${w.current_stock}</td>
        <td>${w.capacity}</td>
        <td>
          <div class="capacity-bar">
            <div class="capacity-fill" style="width: ${percentage}%"></div>
          </div>
          <span class="capacity-label">${percentage}%</span>
        </td>
        <td><span class="status-badge status-${w.is_active ? 'active' : 'inactive'}">${w.is_active ? 'Active' : 'Inactive'}</span></td>
      </tr>`;
    }).join('');
    drawIcons();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="cell-state muted">${esc(err.message)}</td></tr>`;
  }
}

// --- WMS: Inventory ---
async function loadInventory() {
  const container = $('inventoryList');
  container.innerHTML = '<p class="cell-state">Loading inventory…</p>';
  try {
    const inventory = await api('/api/admin/inventory');
    if (!inventory || inventory.length === 0) {
      container.innerHTML = '<p class="cell-state">No inventory data found</p>';
      return;
    }
    const html = `<div class="inventory-grid">
      ${inventory.map(i => `
        <div class="inventory-card">
          <h4>${esc(i.product_name)}</h4>
          <p class="sku">${esc(i.sku)}</p>
          <div class="inventory-stats">
            <div class="stat-line">
              <span>Warehouse:</span> <strong>${esc(i.warehouse_name)}</strong>
            </div>
            <div class="stat-line">
              <span>Quantity:</span> <strong>${i.quantity}</strong>
            </div>
            <div class="stat-line">
              <span>Last Updated:</span> <small>${new Date(i.last_updated).toLocaleDateString()}</small>
            </div>
          </div>
        </div>
      `).join('')}
    </div>`;
    container.innerHTML = html;
    drawIcons();
  } catch (err) {
    container.innerHTML = `<p class="cell-state muted">${esc(err.message)}</p>`;
  }
}

// --- WMS: Stock Movements ---
async function loadStockMovements() {
  const container = $('movementsList');
  container.innerHTML = '<p class="cell-state">Loading stock movements…</p>';
  try {
    const movements = await api('/api/admin/stock-movements');
    if (!movements || movements.length === 0) {
      container.innerHTML = '<p class="cell-state">No stock movements found</p>';
      return;
    }
    const html = `<table class="data-table">
      <thead><tr>
        <th>Warehouse</th>
        <th>Product</th>
        <th>Type</th>
        <th>Quantity</th>
        <th>Reference</th>
        <th>Date</th>
      </tr></thead>
      <tbody>
        ${movements.map(m => `<tr>
          <td>${esc(m.warehouse_name)}</td>
          <td>${esc(m.product_name)}</td>
          <td><span class="badge badge-${m.movement_type}">${esc(m.movement_type)}</span></td>
          <td>${m.quantity}</td>
          <td>${esc(m.reference || '—')}</td>
          <td>${new Date(m.created_at).toLocaleDateString()}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
    container.innerHTML = html;
    drawIcons();
  } catch (err) {
    container.innerHTML = `<p class="cell-state muted">${esc(err.message)}</p>`;
  }
}

// --- ERP: Purchase Orders ---
async function loadPurchaseOrders() {
  const container = $('poList');
  container.innerHTML = '<p class="cell-state">Loading purchase orders…</p>';
  try {
    const pos = await api('/api/admin/purchase-orders');
    if (!pos || pos.length === 0) {
      container.innerHTML = '<p class="cell-state">No purchase orders found</p>';
      return;
    }
    const html = `<table class="data-table">
      <thead><tr>
        <th>PO Number</th>
        <th>Supplier</th>
        <th>Status</th>
        <th>Total Amount</th>
        <th>Created</th>
        <th>Received</th>
      </tr></thead>
      <tbody>
        ${pos.map(p => `<tr>
          <td><strong>${esc(p.po_number)}</strong></td>
          <td>${esc(p.supplier)}</td>
          <td><span class="status-badge status-${p.status}">${esc(p.status)}</span></td>
          <td>${money(p.total_amount)}</td>
          <td>${new Date(p.created_at).toLocaleDateString()}</td>
          <td>${p.received_at ? new Date(p.received_at).toLocaleDateString() : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
    container.innerHTML = html;
    drawIcons();
  } catch (err) {
    container.innerHTML = `<p class="cell-state muted">${esc(err.message)}</p>`;
  }
}

// --- ERP: Reports ---
async function loadReports() {
  const container = $('reportsList');
  container.innerHTML = '<div class="reports-dashboard"><div class="report-card"><h3>Sales Summary</h3><p>No data yet</p></div><div class="report-card"><h3>Inventory Report</h3><p>No data yet</p></div><div class="report-card"><h3>Warehouse Utilization</h3><p>No data yet</p></div></div>';
}

// --- Confirm dialog (promise-based, replaces native confirm) ---
let confirmResolver = null;
function confirmDialog({ title = 'Confirm', body = '', confirmLabel = 'Confirm' }) {
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmOk').textContent = confirmLabel;
  $('confirmOverlay').hidden = false;
  document.body.classList.add('no-scroll');
  $('confirmOk').focus();
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function resolveConfirm(value) {
  $('confirmOverlay').hidden = true;
  document.body.classList.remove('no-scroll');
  if (confirmResolver) { confirmResolver(value); confirmResolver = null; }
}
$('confirmOk').addEventListener('click', () => resolveConfirm(true));
$('confirmCancel').addEventListener('click', () => resolveConfirm(false));
$('confirmOverlay').addEventListener('click', (e) => { if (e.target === $('confirmOverlay')) resolveConfirm(false); });

// Close overlays on Escape / backdrop click.
$('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeModal(); });
$('userModalOverlay').addEventListener('click', (e) => { if (e.target === $('userModalOverlay')) closeUserModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('confirmOverlay').hidden) resolveConfirm(false);
  else if (!$('userModalOverlay').hidden) closeUserModal();
  else if (!$('modalOverlay').hidden) closeModal();
});

// --- Init: restore an existing session if the token is still valid ---
async function init() {
  // Wait for Lucide to be ready if available
  const waitForLucide = () => {
    return new Promise(resolve => {
      if (window.lucide && window.lucide.createIcons) {
        resolve();
      } else {
        const check = setInterval(() => {
          if (window.lucide && window.lucide.createIcons) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        setTimeout(() => clearInterval(check), 3000); // timeout after 3s
      }
    });
  };
  
  await waitForLucide();
  drawIcons();
  
  if (token) {
    try {
      await loadMe(); // probe + load profile; 401 triggers logout()
      enterConsole();
      return;
    } catch { /* token invalid/expired — fall through to login */ }
  }
}

// Wait for DOM to be ready before initializing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
