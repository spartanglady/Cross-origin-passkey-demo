/**
 * PassWallet Embedded SDK
 * Injected into the merchant site to provide a seamless checkout iframe.
 */
(function () {
    if (window.PassWallet) return;

    const WALLET_ORIGIN = window.__CONFIG__?.WALLET_ORIGIN || 'http://localhost:3001';

    class PassWalletSDK {
        constructor() {
            this.iframe = null;
            this.container = null;
            this.isOpen = false;
            this.onCompleteCallback = null;
            this.onCancelCallback = null;

            this.handleMessage = this.handleMessage.bind(this);
            window.addEventListener('message', this.handleMessage);
        }

        /**
         * Initializes the checkout flow.
         * @param {Object} options Options for checkout.
         * @param {HTMLElement} options.container Receptacle for the iframe.
         * @param {Object} options.checkoutData Cart and amount details.
         * @param {Function} options.onComplete Called when payment is successful.
         * @param {Function} options.onCancel Called when user aborts.
         */
        mount(options) {
            this.container = options.container;
            this.onCompleteCallback = options.onComplete;
            this.onCancelCallback = options.onCancel;
            this.checkoutData = options.checkoutData;

            if (!this.container) {
                console.error('PassWallet: Container element required.');
                return;
            }

            this.iframe = document.createElement('iframe');
            this.iframe.src = `${WALLET_ORIGIN}/checkout.html`;
            this.iframe.setAttribute('allow', 'publickey-credentials-get *; publickey-credentials-create *');

            // Styling to make it look like part of the page
            this.iframe.style.cssText = `
        width: 100%;
        height: 60px; /* Initial height, handles resize later */
        border: none;
        border-radius: 8px;
        background: transparent;
        transition: height 0.3s cubic-bezier(0.25, 0.1, 0.25, 1);
        overflow: hidden;
      `;

            this.container.appendChild(this.iframe);
            this.isOpen = true;
        }

        unmount() {
            if (this.iframe) {
                this.iframe.remove();
                this.iframe = null;
            }
            this.isOpen = false;
        }

        handleMessage(event) {
            if (event.origin !== WALLET_ORIGIN) return;

            const { type, data } = event.data;

            switch (type) {
                case 'WALLET_READY':
                    // The iframe has loaded, send the initial cart data so it can build its UI
                    this.iframe.contentWindow.postMessage({
                        type: 'INIT_CHECKOUT',
                        data: this.checkoutData
                    }, WALLET_ORIGIN);
                    break;

                case 'RESIZE_IFRAME':
                    // The wallet UI changed state (e.g. error message), update iframe height
                    if (this.iframe && data.height) {
                        this.iframe.style.height = `${data.height}px`;
                    }
                    break;

                case 'PAYMENT_COMPLETE':
                    if (this.onCompleteCallback) this.onCompleteCallback(data);
                    this.unmount();
                    break;

                case 'CHECKOUT_CANCELLED':
                    if (this.onCancelCallback) this.onCancelCallback();
                    this.unmount();
                    break;
            }
        }
    }

    // Expose globally
    window.PassWallet = new PassWalletSDK();
})();
