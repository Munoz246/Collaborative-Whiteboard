/**
 * Defines the global firebase type which provides type definitions in the code
 * editors.
 */

declare global {
  interface Window {
    firebase: typeof import('firebase/compat/app').default;
  }

  class QRCode {
    constructor(element: HTMLElement, options: { text: string; width?: number; height?: number; colorDark?: string; colorLight?: string });
    makeCode(text: string): void;
    clear(): void;
  }
}

export {};
