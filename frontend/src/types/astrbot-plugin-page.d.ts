export {};

declare global {
  interface Window {
    AstrBotPluginView?: {
      ready: () => Promise<unknown>;
      t: (key: string, fallback?: string) => string;
      apiGet: <T>(endpoint: string, params?: Record<string, string | number | boolean>) => Promise<T>;
      apiPost: <T>(endpoint: string, body: unknown) => Promise<T>;
      subscribeSSE: (
        endpoint: string,
        handlers: {
          onMessage: (event: { raw: string; parsed: unknown }) => void;
          onClose?: () => void;
          onError?: () => void;
        },
        params?: Record<string, string>,
      ) => Promise<string>;
      unsubscribeSSE: (subscriptionId: string) => Promise<unknown>;
    };
  }
}
