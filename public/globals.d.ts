/**
 * Defines the global firebase type which provides type definitions in the code
 * editors.
 */

declare global {
  interface Window {
    firebase: typeof import('firebase/compat/app').default;
  }
}

export {};
