'use strict';

// Storefront logic: load the catalogue from the API, manage a simple in-memory
// cart, and submit a purchase order. State lives only in the browser until the
// order is placed, at which point it is written to the database via the API.

const state = { products: [], cart: {} }; // cart: { productId: quantity }

const grid = document.getElementById('productGrid');
const categoryFilter = document.getElementById('categoryFilter');
const search = document.getElementById('search');
const cart = document.getElementById('cart');
const overlay = document.getElementById('overlay');
const cartItems = document.getElementById('cartItems');
const cartTotal = document.getElementById('cartTotal');
const cartCount = document.getElementById('cartCount');
const orderResult = document.getElementById('orderResult');
const chipRow = document.getElementById('chipRow');
const resultCount = document.getElementById('resultCount');
const cartLink = document.getElementById('cartLink');

const money = (n) => '$' + Number(n).toFixed(2);

// Escape user/DB-supplied text before interpolating into innerHTML, so a product
// name or SKU containing markup can never inject script or break the layout.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Render any Lucide icon placeholders that were just added to the DOM.
const drawIcons = () => { if (window.lucide) window.lucide.createIcons(); };

// Category → representative product photo (Unsplash, free to hot-link).
// Keyed by the seed catalogue categories; falls back to a generic apparel shot.
const CATEGORY_IMAGES = {
  'T-Shirts': 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=600&q=70',
  'Hoodies': 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=600&q=70',
  'Denim': 'https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=600&q=70',
  'Jackets': 'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=600&q=70',
  'Accessories': 'https://images.unsplash.com/photo-1576871337622-98d48d1cf531?auto=format&fit=crop&w=600&q=70',
};
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?auto=format&fit=crop&w=600&q=70';
// Prefer the product's own image; fall back to a category photo, then generic.
const imageFor = (p) => (p && p.image_url) || CATEGORY_IMAGES[p && p.category] || FALLBACK_IMAGE;

const LOW_STOCK_THRESHOLD = 100;

let categories = [];

async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    categories = await res.json();
    for (const c of categories) {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      categoryFilter.appendChild(opt);
    }
    renderChips();
    const statCats = document.getElementById('statCats');
    if (statCats) statCats.textContent = categories.length;
  } catch { /* non-fatal */ }
}

// Quick-filter pills above the grid; mirror the <select> value both ways.
function renderChips() {
  const active = categoryFilter.value;
  const all = [['', 'All']].concat(categories.map((c) => [c, c]));
  chipRow.innerHTML = '';
  for (const [value, label] of all) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (value === active ? ' active' : '');
    chip.textContent = label;
    chip.setAttribute('aria-pressed', value === active ? 'true' : 'false');
    chip.addEventListener('click', () => {
      categoryFilter.value = value;
      renderChips();
      loadProducts();
    });
    chipRow.appendChild(chip);
  }
}

function skeletonGrid() {
  grid.setAttribute('aria-busy', 'true');
  grid.innerHTML = Array.from({ length: 8 }, () => `
    <div class="card card-skeleton" aria-hidden="true">
      <div class="card-img skeleton"></div>
      <div class="card-body">
        <span class="skeleton skel-line" style="width:80%"></span>
        <span class="skeleton skel-line" style="width:40%"></span>
        <span class="skeleton skel-line" style="width:55%;height:22px;margin-top:8px"></span>
        <span class="skeleton skel-line" style="width:100%;height:40px;margin-top:auto"></span>
      </div>
    </div>`).join('');
}

const hasActiveFilters = () => !!(categoryFilter.value || search.value.trim());

async function loadProducts() {
  const params = new URLSearchParams();
  if (categoryFilter.value) params.set('category', categoryFilter.value);
  if (search.value.trim()) params.set('q', search.value.trim());
  skeletonGrid();
  try {
    const res = await fetch('/api/products?' + params.toString());
    if (!res.ok) throw new Error('bad response');
    state.products = await res.json();
    // The SKU count in the hero reflects the full catalogue, so only update it
    // on an unfiltered load.
    if (!hasActiveFilters()) {
      const statSkus = document.getElementById('statSkus');
      if (statSkus) statSkus.textContent = state.products.length;
    }
    renderProducts();
  } catch {
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = `
      <div class="grid-state">
        <i data-lucide="wifi-off" aria-hidden="true"></i>
        <p>We couldn't load the catalogue.</p>
        <button type="button" class="ghost" id="retryLoad">Try again</button>
      </div>`;
    const retry = document.getElementById('retryLoad');
    if (retry) retry.addEventListener('click', loadProducts);
    drawIcons();
  }
}

function renderProducts() {
  grid.setAttribute('aria-busy', 'false');
  resultCount.textContent = state.products.length
    ? `${state.products.length} product${state.products.length === 1 ? '' : 's'}`
    : '';
  if (!state.products.length) {
    grid.innerHTML = `
      <div class="grid-state">
        <i data-lucide="search-x" aria-hidden="true"></i>
        <p>No products match your filters.</p>
        ${hasActiveFilters() ? '<button type="button" class="ghost" id="clearFilters">Clear filters</button>' : ''}
      </div>`;
    const clear = document.getElementById('clearFilters');
    if (clear) clear.addEventListener('click', () => {
      categoryFilter.value = ''; search.value = '';
      renderChips(); loadProducts();
    });
    drawIcons();
    return;
  }
  grid.innerHTML = '';
  for (const p of state.products) {
    const low = p.stock < LOW_STOCK_THRESHOLD;
    const out = p.stock === 0;
    const inCart = !!state.cart[p.id];
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-img">
        <img src="${imageFor(p)}" alt="${esc(p.name)}" loading="lazy"
             onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" />
        <span class="cat-tag">${esc(p.category)}</span>
        ${low && !out ? '<span class="img-tag low"><i data-lucide="alert-triangle"></i> Low stock</span>' : ''}
        ${out ? '<span class="img-tag out">Out of stock</span>' : ''}
      </div>
      <div class="card-body">
        <span class="name">${esc(p.name)}</span>
        <span class="sku">${esc(p.sku)}</span>
        <div class="price-row"><span class="per">from</span><span class="price">${money(p.unit_price)}</span><span class="per">/ pack</span></div>
        <div class="meta">
          <span><i data-lucide="package"></i> MOQ ${p.moq}</span>
          <span class="${low ? 'low' : ''}"><i data-lucide="boxes"></i> ${p.stock} in stock</span>
        </div>
        <button type="button" class="btn-add${inCart ? ' added' : ''}" data-id="${p.id}" ${out ? 'disabled' : ''}>
          ${out ? 'Out of stock'
                : inCart ? '<i data-lucide="check"></i> In your order'
                         : '<i data-lucide="plus"></i> Add to order'}
        </button>
      </div>`;
    grid.appendChild(card);
  }
  grid.querySelectorAll('.btn-add').forEach((btn) => {
    btn.addEventListener('click', () => addToCart(parseInt(btn.dataset.id, 10)));
  });
  drawIcons();
}

// Adding from a card seeds the line at the MOQ; quantity is then tuned in the
// drawer with the steppers. Re-adding an item just opens the drawer on it.
function addToCart(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p || p.stock === 0) return;
  if (!state.cart[id]) state.cart[id] = Math.min(p.moq, p.stock);
  renderProducts();
  renderCart();
  openCart();
}

function setQty(id, qty) {
  const p = state.products.find((x) => x.id === parseInt(id, 10));
  if (!p) return;
  const clamped = Math.max(p.moq, Math.min(qty, p.stock));
  state.cart[id] = clamped;
  renderProducts();
  renderCart();
}

function removeFromCart(id) { delete state.cart[id]; renderProducts(); renderCart(); }

function cartTotalValue() {
  return Object.entries(state.cart).reduce((sum, [id, qty]) => {
    const p = state.products.find((x) => x.id === parseInt(id, 10));
    return sum + (p ? Number(p.unit_price) * qty : 0);
  }, 0);
}

function renderCart() {
  const entries = Object.entries(state.cart);
  const count = entries.reduce((n, [, q]) => n + q, 0);
  cartCount.textContent = count;
  cartCount.hidden = count === 0;
  cartLink.setAttribute('aria-label', count ? `Open your order (${count} items)` : 'Open your order');
  if (!entries.length) {
    cartItems.innerHTML = '<div class="cart-empty"><i data-lucide="shopping-bag" aria-hidden="true"></i><p>No items yet.<br />Add packs from the catalogue.</p></div>';
  } else {
    cartItems.innerHTML = '';
    for (const [id, qty] of entries) {
      const p = state.products.find((x) => x.id === parseInt(id, 10));
      if (!p) continue;
      const atMin = qty <= p.moq;
      const atMax = qty >= p.stock;
      const line = document.createElement('div');
      line.className = 'cart-line';
      line.innerHTML = `
        <img class="ci-img" src="${imageFor(p)}" alt=""
             onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" />
        <div class="ci-info">
          <div class="ci-name">${esc(p.name)}</div>
          <div class="ci-sub">${money(p.unit_price)} / pack · MOQ ${p.moq}</div>
          <div class="stepper" data-id="${id}">
            <button type="button" class="step-dec" ${atMin ? 'disabled' : ''} aria-label="Decrease quantity"><i data-lucide="minus"></i></button>
            <input class="step-val" type="number" inputmode="numeric" value="${qty}" min="${p.moq}" max="${p.stock}" aria-label="Quantity for ${esc(p.name)}" />
            <button type="button" class="step-inc" ${atMax ? 'disabled' : ''} aria-label="Increase quantity"><i data-lucide="plus"></i></button>
          </div>
        </div>
        <div class="ci-right">
          <div class="ci-amt">${money(Number(p.unit_price) * qty)}</div>
          <button type="button" class="ci-remove" data-remove="${id}" aria-label="Remove ${esc(p.name)}"><i data-lucide="trash-2"></i></button>
        </div>`;
      cartItems.appendChild(line);
    }
    cartItems.querySelectorAll('.stepper').forEach((s) => {
      const id = s.dataset.id;
      s.querySelector('.step-dec').addEventListener('click', () => setQty(id, state.cart[id] - 1));
      s.querySelector('.step-inc').addEventListener('click', () => setQty(id, state.cart[id] + 1));
      s.querySelector('.step-val').addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        if (Number.isInteger(v)) setQty(id, v); else renderCart();
      });
    });
    cartItems.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => removeFromCart(b.dataset.remove)));
  }
  cartTotal.textContent = money(cartTotalValue());
  drawIcons();
}

// --- Drawer open/close with focus management ---
let lastFocused = null;

function openCart() {
  lastFocused = document.activeElement;
  overlay.hidden = false;
  // next frame so the transition runs from the hidden state
  requestAnimationFrame(() => overlay.classList.add('show'));
  cart.classList.add('open');
  cart.setAttribute('aria-hidden', 'false');
  document.body.classList.add('no-scroll');
  document.getElementById('closeCart').focus();
}

function closeCart() {
  cart.classList.remove('open');
  overlay.classList.remove('show');
  cart.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('no-scroll');
  // hide overlay after its fade-out so it doesn't trap clicks
  setTimeout(() => { overlay.hidden = true; }, 200);
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}

// Keep tab focus inside the drawer while it is open.
cart.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const focusable = cart.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), a[href]');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cart.classList.contains('open')) closeCart();
});

// --- Client-side validation ---
function setFieldError(input, errorEl, message) {
  if (message) {
    input.classList.add('invalid');
    input.setAttribute('aria-invalid', 'true');
    errorEl.textContent = message;
  } else {
    input.classList.remove('invalid');
    input.removeAttribute('aria-invalid');
    errorEl.textContent = '';
  }
}

function validateCheckout() {
  const nameInput = document.getElementById('buyerName');
  const emailInput = document.getElementById('buyerEmail');
  let ok = true;
  if (!nameInput.value.trim()) {
    setFieldError(nameInput, document.getElementById('buyerNameError'), 'Please enter a business or buyer name.');
    ok = false;
  } else setFieldError(nameInput, document.getElementById('buyerNameError'), '');

  const email = emailInput.value.trim();
  if (!email) {
    setFieldError(emailInput, document.getElementById('buyerEmailError'), 'Please enter an email address.');
    ok = false;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setFieldError(emailInput, document.getElementById('buyerEmailError'), 'Please enter a valid email address.');
    ok = false;
  } else setFieldError(emailInput, document.getElementById('buyerEmailError'), '');
  return ok;
}

async function placeOrder(e) {
  e.preventDefault();
  const entries = Object.entries(state.cart);
  if (!entries.length) {
    orderResult.textContent = 'Your order is empty — add some packs first.';
    orderResult.className = 'drawer-note err';
    return;
  }
  if (!validateCheckout()) {
    orderResult.textContent = '';
    orderResult.className = 'drawer-note';
    return;
  }
  const btn = document.getElementById('placeOrderBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  orderResult.textContent = 'Submitting your order…';
  orderResult.className = 'drawer-note';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyer_name: document.getElementById('buyerName').value.trim(),
        buyer_email: document.getElementById('buyerEmail').value.trim(),
        items: entries.map(([product_id, quantity]) => ({ product_id: parseInt(product_id, 10), quantity })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Order failed');
    orderResult.innerHTML = `<span><i data-lucide="check-circle"></i> Order <strong>${esc(data.reference)}</strong> received — total ${money(data.total)}. A confirmation will follow by email.</span>
      <button type="button" class="link-btn" id="trackPlacedOrder">Track this order</button>`;
    orderResult.className = 'drawer-note ok stacked';
    const placedRef = data.reference;
    document.getElementById('trackPlacedOrder').addEventListener('click', () => { closeCart(); openTrack(placedRef); lookupOrder(); });
    state.cart = {}; renderCart();
    document.getElementById('checkoutForm').reset();
    loadProducts(); // refresh stock figures
    drawIcons();
  } catch (err) {
    orderResult.textContent = err.message;
    orderResult.className = 'drawer-note err';
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// --- Track order ---
const trackOverlay = document.getElementById('trackOverlay');
const trackResult = document.getElementById('trackResult');
const trackRef = document.getElementById('trackRef');
const trackError = document.getElementById('trackError');
let trackLastFocused = null;

const ORDER_STEPS = ['received', 'processing', 'dispatched'];
const STATUS_LABELS = {
  received: 'Received', processing: 'Processing', dispatched: 'Dispatched', cancelled: 'Cancelled',
};

function openTrack(prefill) {
  trackLastFocused = document.activeElement;
  trackError.textContent = '';
  trackResult.innerHTML = '';
  if (prefill) trackRef.value = prefill;
  trackOverlay.hidden = false;
  document.body.classList.add('no-scroll');
  trackRef.focus();
  drawIcons();
}
function closeTrack() {
  trackOverlay.hidden = true;
  document.body.classList.remove('no-scroll');
  if (trackLastFocused && trackLastFocused.focus) trackLastFocused.focus();
}

function renderTrackProgress(status) {
  if (status === 'cancelled') {
    return `<div class="track-cancelled"><i data-lucide="x-circle"></i> This order was cancelled.</div>`;
  }
  const current = ORDER_STEPS.indexOf(status);
  return `<ol class="track-steps">
    ${ORDER_STEPS.map((s, i) => `
      <li class="track-step ${i < current ? 'done' : ''} ${i === current ? 'current' : ''}">
        <span class="track-dot"><i data-lucide="${i <= current ? 'check' : 'circle'}"></i></span>
        <span class="track-step-label">${STATUS_LABELS[s]}</span>
      </li>`).join('')}
  </ol>`;
}

async function lookupOrder(e) {
  if (e) e.preventDefault();
  const ref = trackRef.value.trim().toUpperCase();
  trackError.textContent = '';
  trackResult.innerHTML = '';
  if (!ref) { trackError.textContent = 'Enter your order reference.'; return; }
  const btn = document.getElementById('trackBtn');
  btn.disabled = true; btn.classList.add('loading');
  try {
    const res = await fetch('/api/orders/' + encodeURIComponent(ref));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lookup failed');
    const date = new Date(data.created_at).toLocaleString();
    const items = data.items.map((i) =>
      `<li>${i.quantity}× ${esc(i.name)} <span class="ci-sub">${money(i.unit_price)} / pack</span></li>`).join('');
    trackResult.innerHTML = `
      <div class="track-card">
        <div class="track-card-head">
          <div>
            <div class="track-ref">${esc(data.reference)}</div>
            <div class="ci-sub">Placed by ${esc(data.buyer_name)} · ${esc(date)}</div>
          </div>
          <div class="track-total">${money(data.total)}</div>
        </div>
        ${renderTrackProgress(data.status)}
        <ul class="track-items">${items}</ul>
      </div>`;
    drawIcons();
  } catch (err) {
    trackResult.innerHTML = `<div class="track-empty"><i data-lucide="search-x"></i><p>${esc(err.message)}</p></div>`;
    drawIcons();
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
  }
}

document.getElementById('trackLink').addEventListener('click', () => openTrack());
document.getElementById('closeTrack').addEventListener('click', closeTrack);
trackOverlay.addEventListener('click', (e) => { if (e.target === trackOverlay) closeTrack(); });
document.getElementById('trackForm').addEventListener('submit', lookupOrder);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !trackOverlay.hidden) closeTrack(); });

async function showServedBy() {
  try {
    const res = await fetch('/health');
    const h = await res.json();
    const el = document.getElementById('servedBy');
    el.innerHTML = `<i data-lucide="server" aria-hidden="true"></i> served by instance ${esc(h.instance)}`;
    drawIcons();
  } catch { /* ignore */ }
}

// Wire up events
cartLink.addEventListener('click', (e) => { e.preventDefault(); openCart(); });
document.getElementById('closeCart').addEventListener('click', closeCart);
overlay.addEventListener('click', closeCart);
document.getElementById('checkoutForm').addEventListener('submit', placeOrder);
// Clear a field's error as the user corrects it.
document.getElementById('buyerName').addEventListener('input', (e) => {
  if (e.target.classList.contains('invalid')) setFieldError(e.target, document.getElementById('buyerNameError'), '');
});
document.getElementById('buyerEmail').addEventListener('input', (e) => {
  if (e.target.classList.contains('invalid')) setFieldError(e.target, document.getElementById('buyerEmailError'), '');
});
categoryFilter.addEventListener('change', () => { renderChips(); loadProducts(); });
let searchTimer;
search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadProducts, 300); });

// Init — run after the DOM is parsed (script is deferred, so this is safe).
drawIcons();
loadCategories();
loadProducts();
renderCart();
showServedBy();
