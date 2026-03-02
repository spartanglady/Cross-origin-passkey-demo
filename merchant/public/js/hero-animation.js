// merchant/public/js/hero-animation.js
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('hero-keyboard-canvas');
    if (!canvas) return;

    // A simplified 65% keyboard layout map
    // Each row array dictates how many keys and their relative width multiplier
    const layout = [
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1],       // Number row (Escape + Backspace is 2u, last is nav)
        [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 1],   // Tab row
        [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25, 1],    // Caps row
        [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.75, 1],       // Shift row + nav
        [1.25, 1.25, 1.25, 6.25, 1.25, 1.25, 1, 1, 1]        // Bottom row (Spacebar is 6.25u)
    ];

    const keys = [];

    // Base dimensions for 1u key
    const unitSize = 40;
    const gap = 4;

    let canvasWidth = 0;
    let canvasHeight = layout.length * (unitSize + gap);

    // Build the keys
    layout.forEach((row, rowIndex) => {
        let xOffset = 0;
        let rowWidth = 0;

        row.forEach((keySize) => {
            const width = (keySize * unitSize) + ((keySize - 1) * gap);
            const height = unitSize;

            const keyEl = document.createElement('div');
            keyEl.className = 'anim-keycap';

            // Random scatter start position
            const startX = (Math.random() - 0.5) * 800;
            const startY = (Math.random() - 0.5) * 800;
            const startZ = Math.random() * 1000 + 400; // Fly in from towards the camera
            const rotX = Math.random() * 360;
            const rotY = Math.random() * 360;
            const rotZ = Math.random() * 360;

            const targetX = xOffset;
            const targetY = rowIndex * (unitSize + gap);

            // Set initial scattered styles
            keyEl.style.width = `${width}px`;
            keyEl.style.height = `${height}px`;
            keyEl.style.transform = `translate3d(${startX}px, ${startY}px, ${startZ}px) rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg)`;
            keyEl.style.opacity = '0';

            // Target coordinates saved on dataset to avoid recalculating
            keyEl.dataset.tx = targetX;
            keyEl.dataset.ty = targetY;

            canvas.appendChild(keyEl);
            keys.push(keyEl);

            xOffset += width + gap;
            rowWidth += width + gap;
        });

        if (rowWidth > canvasWidth) canvasWidth = rowWidth;
    });

    // Center the container internally
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    // Trigger the assembly animation slightly after page load for guaranteed layout calculations
    setTimeout(() => {
        keys.forEach((keyEl, index) => {
            // Apply a staggered delay to make it look like a swarm assembling
            const delay = Math.random() * 1200 + (index * 5);

            setTimeout(() => {
                keyEl.style.opacity = '1';
                keyEl.style.transform = `translate3d(${keyEl.dataset.tx}px, ${keyEl.dataset.ty}px, 0) rotateX(0deg) rotateY(0deg) rotateZ(0deg)`;
            }, delay);
        });
    }, 300);

    // Random hover breathing effect post-assembly
    setTimeout(() => {
        canvas.classList.add('assembled');

        // Add subtle continuous floating to a few random keys occasionally
        setInterval(() => {
            const randomKey = keys[Math.floor(Math.random() * keys.length)];
            randomKey.style.transition = 'transform 0.4s ease-out';
            randomKey.style.transform = `translate3d(${randomKey.dataset.tx}px, ${randomKey.dataset.ty}px, 15px)`;

            setTimeout(() => {
                randomKey.style.transition = 'transform 0.6s ease-in';
                randomKey.style.transform = `translate3d(${randomKey.dataset.tx}px, ${randomKey.dataset.ty}px, 0)`;
            }, 400);

        }, 800);

    }, 2500); // Trigger after all keys have finished their 1s flight

});
