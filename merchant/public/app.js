document.addEventListener('DOMContentLoaded', () => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let cart = [];

  const products = [
    { id: '1', name: 'Wireless Pro Headphones', price: 349.99, category: 'electronics', gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
    { id: '2', name: 'Smart Watch Ultra', price: 499.99, category: 'electronics', gradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' },
    { id: '3', name: 'Leather MacBook Sleeve', price: 89.99, category: 'accessories', gradient: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' },
    { id: '4', name: 'USB-C Hub Pro', price: 79.99, category: 'electronics', gradient: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)' },
    { id: '5', name: 'Merino Tech Tee', price: 65.00, category: 'clothing', gradient: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)' },
    { id: '6', name: 'Minimal Desk Lamp', price: 129.99, category: 'accessories', gradient: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)' },
  ];

  // Wallet origin: resolved lazily so async config fetch has time to complete
  function getWalletOrigin() {
    if (window.__CONFIG__ && window.__CONFIG__.WALLET_ORIGIN) {
      return window.__CONFIG__.WALLET_ORIGIN;
    }
    if (window.location.hostname === 'merchant.demo') return 'http://wallet.demo:3001';
    return 'http://localhost:3001';
  }

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------
  const cartCount = document.getElementById('cart-count');
  const cartDrawer = document.getElementById('cart-drawer');
  const cartOverlay = document.getElementById('cart-overlay');
  const cartItemsContainer = document.getElementById('cart-items');
  const cartSubtotal = document.getElementById('cart-subtotal');
  const cartShipping = document.getElementById('cart-shipping');
  const cartTotal = document.getElementById('cart-total');
  const checkoutBtn = document.getElementById('checkout-btn');
  const walletModal = document.getElementById('wallet-modal');
  const walletIframeContainer = document.getElementById('wallet-iframe-container');
  const orderConfirmation = document.getElementById('order-confirmation');
  const confTransactionId = document.getElementById('conf-transaction-id');
  const confPaymentMethod = document.getElementById('conf-payment-method');
  const confAmount = document.getElementById('conf-amount');
  const continueShoppingBtn = document.getElementById('continue-shopping-btn');

  // ---------------------------------------------------------------------------
  // 1. Category Filtering
  // ---------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-category]');
    if (!tab) return;

    const category = tab.dataset.category;

    // Toggle active state on tabs
    document.querySelectorAll('[data-category]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');

    // Show/hide product cards
    document.querySelectorAll('[data-product-id]').forEach((card) => {
      const cardEl = card.closest('.product-card') || card.parentElement;
      if (category === 'all' || card.dataset.category === category || cardEl.dataset.category === category) {
        cardEl.style.display = '';
      } else {
        cardEl.style.display = 'none';
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Add to Cart
  // ---------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.add-to-cart-btn');
    if (!btn) return;

    const id = btn.dataset.productId;
    const product = products.find((p) => p.id === id);
    if (!product) return;

    // Add to cart or increment quantity
    const existing = cart.find((item) => item.id === id);
    if (existing) {
      existing.qty += 1;
    } else {
      cart.push({
        id: product.id,
        name: product.name,
        price: product.price,
        gradient: product.gradient,
        qty: 1,
      });
    }

    // Update badge with bounce animation
    updateCartBadge();
    if (cartCount) {
      cartCount.style.transform = 'scale(1.3)';
      setTimeout(() => {
        cartCount.style.transform = 'scale(1)';
      }, 200);
    }

    // "Added!" feedback on button
    const originalText = btn.textContent;
    btn.textContent = 'Added!';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1000);

    updateCartDrawer();
  });

  // ---------------------------------------------------------------------------
  // 3. Cart Drawer
  // ---------------------------------------------------------------------------

  // Open cart drawer – delegate from any element with a cart-toggle role or
  // the cart icon itself. We look for an element that should open the cart.
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('#cart-toggle, .cart-icon, [data-open-cart]');
    if (!trigger) return;
    openCartDrawer();
  });

  // Close cart drawer via overlay
  if (cartOverlay) {
    cartOverlay.addEventListener('click', closeCartDrawer);
  }

  // Close cart drawer via close button (delegate)
  document.addEventListener('click', (e) => {
    if (e.target.closest('.cart-drawer-close, #cart-drawer-close')) {
      closeCartDrawer();
    }
  });

  function openCartDrawer() {
    if (cartDrawer) cartDrawer.classList.add('open');
    if (cartOverlay) cartOverlay.classList.add('open');
  }

  function closeCartDrawer() {
    if (cartDrawer) cartDrawer.classList.remove('open');
    if (cartOverlay) cartOverlay.classList.remove('open');
  }

  function updateCartBadge() {
    if (!cartCount) return;
    const total = cart.reduce((sum, item) => sum + item.qty, 0);
    cartCount.textContent = total;
    cartCount.style.display = total > 0 ? '' : 'none';
  }

  function updateCartDrawer() {
    if (!cartItemsContainer) return;

    // Render cart items
    if (cart.length === 0) {
      cartItemsContainer.innerHTML = '<p class="cart-empty">Your cart is empty</p>';
    } else {
      cartItemsContainer.innerHTML = cart
        .map(
          (item) => `
        <div class="cart-item">
          <div class="cart-item-image" style="background: ${item.gradient}"></div>
          <div class="cart-item-details">
            <div class="cart-item-name">${item.name}</div>
            <div class="cart-item-price">$${item.price.toFixed(2)}</div>
            <div class="cart-item-quantity">
              <button class="qty-btn minus" data-id="${item.id}">\u2212</button>
              <span>${item.qty}</span>
              <button class="qty-btn plus" data-id="${item.id}">+</button>
              <button class="remove-btn" data-id="${item.id}">Remove</button>
            </div>
          </div>
        </div>
      `
        )
        .join('');
    }

    // Calculate totals
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    const shipping = subtotal > 0 && subtotal < 100 ? 9.99 : 0;
    const total = subtotal + shipping;

    if (cartSubtotal) cartSubtotal.textContent = `$${subtotal.toFixed(2)}`;
    if (cartShipping) cartShipping.textContent = shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`;
    if (cartTotal) cartTotal.textContent = `$${total.toFixed(2)}`;

    // Enable/disable checkout button
    if (checkoutBtn) {
      checkoutBtn.disabled = cart.length === 0;
    }

    updateCartBadge();
  }

  // Quantity +/- and Remove – event delegation on #cart-items
  if (cartItemsContainer) {
    cartItemsContainer.addEventListener('click', (e) => {
      const plusBtn = e.target.closest('.qty-btn.plus');
      const minusBtn = e.target.closest('.qty-btn.minus');
      const removeBtn = e.target.closest('.remove-btn');

      if (plusBtn) {
        const item = cart.find((i) => i.id === plusBtn.dataset.id);
        if (item) {
          item.qty += 1;
          updateCartDrawer();
        }
      } else if (minusBtn) {
        const item = cart.find((i) => i.id === minusBtn.dataset.id);
        if (item) {
          item.qty -= 1;
          if (item.qty <= 0) {
            cart = cart.filter((i) => i.id !== item.id);
          }
          updateCartDrawer();
        }
      } else if (removeBtn) {
        cart = cart.filter((i) => i.id !== removeBtn.dataset.id);
        updateCartDrawer();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Wallet Modal (iframe)
  // ---------------------------------------------------------------------------
  function openWallet() {
    // Calculate total
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    if (subtotal === 0) return;

    // Close the cart drawer first
    closeCartDrawer();

    // Show the wallet modal
    if (walletModal) walletModal.classList.add('active');

    // Create and append iframe
    if (walletIframeContainer) {
      // Remove any existing iframe first
      const existing = document.getElementById('wallet-iframe');
      if (existing) existing.remove();

      const iframe = document.createElement('iframe');
      iframe.src = `${getWalletOrigin()}/checkout.html`;
      iframe.setAttribute('allow', 'publickey-credentials-get; publickey-credentials-create');
      iframe.id = 'wallet-iframe';
      iframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:16px;';
      walletIframeContainer.appendChild(iframe);
    }

    // Prevent background scrolling
    document.body.style.overflow = 'hidden';
  }

  function closeWallet() {
    if (walletModal) walletModal.classList.remove('active');

    // Remove the iframe
    const iframe = document.getElementById('wallet-iframe');
    if (iframe) iframe.remove();

    // Restore scrolling
    document.body.style.overflow = 'auto';
  }

  // Checkout button opens wallet
  if (checkoutBtn) {
    checkoutBtn.addEventListener('click', openWallet);
  }

  // Modal close button
  document.addEventListener('click', (e) => {
    if (e.target.closest('.wallet-modal-close')) {
      closeWallet();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. postMessage Communication
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.origin !== getWalletOrigin()) return;

    const { type, data } = event.data;

    switch (type) {
      case 'WALLET_READY': {
        // Send checkout data to wallet
        const iframe = document.getElementById('wallet-iframe');
        if (iframe) {
          const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
          const shipping = subtotal >= 100 ? 0 : 9.99;
          iframe.contentWindow.postMessage(
            {
              type: 'INIT_CHECKOUT',
              data: {
                amount: (subtotal + shipping).toFixed(2),
                items: cart.map((item) => ({ name: item.name, price: item.price, qty: item.qty })),
                merchantName: 'TechStore',
              },
            },
            getWalletOrigin()
          );
        }
        break;
      }

      case 'PAYMENT_COMPLETE':
        closeWallet();
        showConfirmation(data);
        break;

      case 'CHECKOUT_CANCELLED':
        closeWallet();
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Order Confirmation
  // ---------------------------------------------------------------------------
  function showConfirmation(data) {
    if (orderConfirmation) orderConfirmation.classList.add('active');

    if (confTransactionId) confTransactionId.textContent = data.transactionId;
    if (confPaymentMethod) confPaymentMethod.textContent = `${data.cardBrand} \u2022\u2022\u2022\u2022${data.last4}`;
    if (confAmount) confAmount.textContent = `$${data.amount}`;

    // Clear cart
    cart = [];
    updateCartBadge();
    updateCartDrawer();
  }

  // Continue shopping button
  if (continueShoppingBtn) {
    continueShoppingBtn.addEventListener('click', () => {
      if (orderConfirmation) orderConfirmation.classList.remove('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Smooth Scroll – "Shop Now" hero button
  // ---------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const heroBtn = e.target.closest('.hero-cta, [data-scroll-to-products]');
    if (!heroBtn) return;

    e.preventDefault();
    const productsSection = document.getElementById('products') || document.querySelector('.products-section');
    if (productsSection) {
      productsSection.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Header Scroll Effect
  // ---------------------------------------------------------------------------
  const header = document.querySelector('header');

  window.addEventListener('scroll', () => {
    if (!header) return;
    if (window.scrollY > 10) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  });

  // ---------------------------------------------------------------------------
  // Initial render
  // ---------------------------------------------------------------------------
  updateCartDrawer();
});
