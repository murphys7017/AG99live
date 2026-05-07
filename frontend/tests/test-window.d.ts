// Augment Window interface for test environment
declare global {
  interface Window {
    ag99desktop?: any;
    getLAppAdapter?: any;
  }
}

export {};
