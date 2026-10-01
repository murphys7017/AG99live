export {};

declare global {
  interface Window {
    AstrBotPluginView?: {
      ready: () => Promise<unknown>;
      t: (key: string, fallback?: string) => string;
      apiGet: <T>(endpoint: string, params?: Record<string, string | number | boolean>) => Promise<T>;
      apiPost: <T>(endpoint: string, body: unknown) => Promise<T>;
    };
  }
}
