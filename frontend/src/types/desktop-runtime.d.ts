import type {
  DesktopAuxWindowRole,
  DesktopMicrophoneAudioChunk,
  DesktopMicrophoneDevice,
  DesktopPttEventAck,
  DesktopPttKeyBinding,
  DesktopWindowVisibilityState,
} from "./desktop";

export interface Ag99DesktopApi {
  showContextMenu: (position?: {
    x?: number;
    y?: number;
    screenX?: number;
    screenY?: number;
  }) => void;
  setIgnoreMouseEvents: (ignore: boolean) => void;
  startWindowDrag: (screenX: number, screenY: number) => void;
  updateWindowDrag: (screenX: number, screenY: number) => void;
  endWindowDrag: () => void;
  getLocalAdapterHosts: () => string[];
  captureDesktopScreenshot: () => Promise<{
    data: string;
    mime_type: "image/jpeg";
    source: "screen";
    captured_at: string;
  } | null>;
  listNativeMicrophones: () => Promise<DesktopMicrophoneDevice[]>;
  startNativeMicrophoneCapture: (
    deviceId: string | null,
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  stopNativeMicrophoneCapture: (sessionId: string) => Promise<boolean>;
  toggleAuxWindow: (target: DesktopAuxWindowRole) => void;
  closeCurrentWindow: () => void;
  minimizeCurrentWindow: () => void;
  setOverlayContentHeight: (height: number) => void;
  setPttMode: (enabled: boolean, binding?: DesktopPttKeyBinding) => void;
  reportPttEventAck: (ack: DesktopPttEventAck) => void;
  onIpc: <TPayload = unknown>(
    channel: string,
    callback: (payload: TPayload) => void,
  ) => () => void;
  onNativeMicrophoneChunk: (
    callback: (chunk: DesktopMicrophoneAudioChunk & { sessionId: string }) => void,
  ) => () => void;
  onNativeMicrophoneEnded: (
    callback: (payload: { sessionId: string; reason: string }) => void,
  ) => () => void;
  onNativeMicrophoneError: (
    callback: (payload: { sessionId: string; error: string }) => void,
  ) => () => void;
  onWindowState: (
    callback: (state: DesktopWindowVisibilityState) => void,
  ) => () => void;
  onForceRedraw: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    ag99desktop?: Ag99DesktopApi;
    api?: Ag99DesktopApi;
  }
}

export {};
