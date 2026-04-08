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
