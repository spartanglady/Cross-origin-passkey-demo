// app.js - Keysmith Merchant Logic
document.addEventListener('DOMContentLoaded', () => {
  let cart = [];

  // DOM Elements
  const cartToggleBtn = document.getElementById('cart-toggle');
  const closeCartBtn = document.getElementById('close-cart-btn');
  const cartOverlay = document.getElementById('cart-overlay');
  const cartDrawer = document.getElementById('cart-drawer');

  const storefrontView = document.getElementById('storefront-view');
  const checkoutPage = document.getElementById('checkout-page');

  const cartItemsContainer = document.getElementById('cart-items');
  const checkoutItemsContainer = document.getElementById('checkout-items-list');
  const cartCount = document.getElementById('cart-count');

  const cartSubtotal = document.getElementById('cart-subtotal');
  const cartTotal = document.getElementById('cart-total');

  const checkoutAmountDisplay = document.getElementById('checkout-amount-display');
  const checkoutSubtotal = document.getElementById('checkout-subtotal');
  const checkoutGrandTotal = document.getElementById('checkout-grand-total');

  const startCheckoutBtn = document.getElementById('start-checkout-btn');
  const backToStoreBtn = document.getElementById('back-to-store-btn');

  const modal = document.getElementById('success-modal');
  const confAmount = document.getElementById('conf-amount');
  const confCard = document.getElementById('conf-card');

  // --- Drawer State ---
  function openDrawer() {
    cartOverlay.classList.add('active');
    cartDrawer.classList.add('open');
  }

  function closeDrawer() {
    cartOverlay.classList.remove('active');
    cartDrawer.classList.remove('open');
  }

  // --- Views ---
  function showCheckoutPage() {
    storefrontView.classList.remove('active');
    checkoutPage.classList.add('active');
    window.scrollTo(0, 0);
  }

  function showStorefrontPage() {
    checkoutPage.classList.remove('active');
    storefrontView.classList.add('active');
  }

  // --- Cart Engine ---
  function updateCartUI() {
    const totalQty = cart.reduce((s, item) => s + item.qty, 0);
    const subtotal = cart.reduce((s, item) => s + (item.price * item.qty), 0);

    // Update badge
    cartCount.textContent = totalQty;
    cartCount.style.display = totalQty > 0 ? 'flex' : 'none';

    // Render drawer items
    if (cart.length === 0) {
      cartItemsContainer.innerHTML = '<p class="empty-msg">Your cart is empty.</p>';
      startCheckoutBtn.disabled = true;
    } else {
      cartItemsContainer.innerHTML = cart.map(item => `
        <div class="cart-item">
          <div class="cart-thumb ${item.bgClass}"></div>
          <div class="cart-details">
            <div class="cart-details-top">
              <span class="cart-item-name">${item.name}</span>
              <span class="cart-item-price">$${item.price.toFixed(2)}</span>
            </div>
            <div class="cart-controls">
              <button class="qty-btn" onclick="updateQty('${item.id}', -1)">-</button>
              <span class="qty-val">${item.qty}</span>
              <button class="qty-btn" onclick="updateQty('${item.id}', 1)">+</button>
              <button class="remove-btn" onclick="removeFromCart('${item.id}')">Remove</button>
            </div>
          </div>
        </div>
      `).join('');
      startCheckoutBtn.disabled = false;
    }

    // Render checkout screen items list
    checkoutItemsContainer.innerHTML = cart.map(item => `
      <div class="checkout-item">
        <div class="checkout-item-thumb ${item.bgClass}">
          <div class="checkout-item-qty">${item.qty}</div>
        </div>
        <div class="checkout-item-info">
          <div>${item.name}</div>
        </div>
        <div class="checkout-item-price">$${(item.price * item.qty).toFixed(2)}</div>
      </div>
    `).join('');

    const formattedSubtotal = `$${subtotal.toFixed(2)}`;

    cartSubtotal.textContent = formattedSubtotal;
    cartTotal.textContent = formattedSubtotal;

    checkoutAmountDisplay.textContent = formattedSubtotal;
    checkoutSubtotal.textContent = formattedSubtotal;
    checkoutGrandTotal.textContent = formattedSubtotal;
  }

  window.updateQty = (id, delta) => {
    const item = cart.find(i => i.id === id);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) window.removeFromCart(id);
    else updateCartUI();
  };

  window.removeFromCart = (id) => {
    cart = cart.filter(i => i.id !== id);
    updateCartUI();
  };

  // Add to cart listeners
  document.querySelectorAll('.add-to-cart-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      const id = card.dataset.id;

      const item = cart.find(i => i.id === id);
      if (item) {
        item.qty += 1;
      } else {
        // extract background class
        const bgClass = Array.from(card.querySelector('.card-image').classList).find(c => c.startsWith('bg-'));
        cart.push({
          id,
          name: card.dataset.name,
          price: parseFloat(card.dataset.price),
          bgClass,
          qty: 1
        });
      }

      updateCartUI();
      openDrawer();
    });
  });

  // --- Event Bindings ---
  cartToggleBtn.addEventListener('click', openDrawer);
  closeCartBtn.addEventListener('click', closeDrawer);
  cartOverlay.addEventListener('click', closeDrawer);

  backToStoreBtn.addEventListener('click', () => {
    if (window.PassWallet) window.PassWallet.unmount();
    showStorefrontPage();
    openDrawer();
  });

  startCheckoutBtn.addEventListener('click', () => {
    if (cart.length === 0) return;

    closeDrawer();
    showCheckoutPage();

    const subtotal = cart.reduce((s, item) => s + (item.price * item.qty), 0);

    // Initialize PassWallet SDK
    if (window.PassWallet) {
      window.PassWallet.mount({
        container: document.getElementById('passwallet-mount-point'),
        checkoutData: {
          amount: subtotal.toFixed(2),
          merchantName: 'KEYSMITH.'
        },
        onComplete: (data) => {
          // data contains { transactionId, last4, cardBrand, amount }
          cart = []; // clear cart
          updateCartUI();

          confAmount.textContent = `$${data.amount}`;
          confCard.textContent = `${data.cardBrand} •••• ${data.last4}`;
          modal.showModal();
        },
        onCancel: () => {
          showStorefrontPage();
          openDrawer();
        }
      });
    } else {
      console.error('PassWallet SDK not loaded yet.');
    }
  });

  // Init
  updateCartUI();
});
