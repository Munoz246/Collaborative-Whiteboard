/**
 * Utility functions that can be used throughout the application.
 */

/**
 * Picks a random element from a list.
 *
 * @template T
 * @param {T[]} list
 * @returns {T} A random value from the list
 */
export function pickRandom(list) {
    const idx = Math.floor( Math.random() * list.length );
    return list[idx];
}

/**
 * Shows a transient toast message at the bottom of the screen.
 * @param {string} message
 */
export function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "wb-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("wb-toast--visible"));
    setTimeout(() => {
        toast.classList.remove("wb-toast--visible");
        toast.addEventListener("transitionend", () => toast.remove(), { once: true });
        setTimeout(() => toast.remove(), 600);
    }, 3000);
}
