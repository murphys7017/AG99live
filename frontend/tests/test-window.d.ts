// Augment Window interface for test environment
// getLAppAdapter is globally declared by live2d-runtime.d.ts via import chain
declare global {
  interface Window {
    ag99desktop?: any;
  }
}

export {};
