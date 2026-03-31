declare global {
  interface Window {
    firebase: typeof import('firebase/compat/app').default;
  }
}

export {};
