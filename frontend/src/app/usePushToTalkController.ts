import type {
  DesktopPttAckStatus,
  DesktopPttEventKind,
  DesktopPttEventPayload,
  DesktopPttKeyBinding,
} from "../types/desktop";
import { matchesPttKeyBinding } from "../adapter-connection/core/pttKeyBinding.js";

export interface PushToTalkAdapterPort {
  readonly state: {
    readonly pttModeEnabled: boolean;
    readonly pttKeyBinding: DesktopPttKeyBinding;
  };
  startPttCapture: () => Promise<DesktopPttAckStatus>;
  stopPttCapture: () => Promise<DesktopPttAckStatus>;
}

export interface PushToTalkController {
  install: () => void;
  dispose: () => void;
}

export function usePushToTalkController(adapter: PushToTalkAdapterPort): PushToTalkController {
  function onPttKeyDown(event: KeyboardEvent): void {
    console.info("[PTT] keydown key=%s repeat=%s pttMode=%s", event.key, event.repeat, adapter.state.pttModeEnabled);
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    if (matchesPttKeyBinding(event, adapter.state.pttKeyBinding) && !event.repeat) {
      console.info("[PTT] starting mic capture");
      void adapter.startPttCapture();
    }
  }

  function onPttKeyUp(event: KeyboardEvent): void {
    console.info("[PTT] keyup key=%s pttMode=%s", event.key, adapter.state.pttModeEnabled);
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    if (matchesPttKeyBinding(event, adapter.state.pttKeyBinding)) {
      console.info("[PTT] stopping mic capture");
      void adapter.stopPttCapture();
    }
  }

  function installPttKeyboardListeners(): void {
    document.addEventListener("keydown", onPttKeyDown);
    document.addEventListener("keyup", onPttKeyUp);
    console.info("[PTT] keyboard listeners installed (document)");
  }

  function removePttKeyboardListeners(): void {
    document.removeEventListener("keydown", onPttKeyDown);
    document.removeEventListener("keyup", onPttKeyUp);
  }

  function onPttIpcKeyDown(payload: DesktopPttEventPayload): void {
    if (!adapter.state.pttModeEnabled) {
      reportPttEvent(payload, "ignored", "ptt mode disabled");
      return;
    }
    console.info("[PTT] IPC keydown");
    reportPttEvent(payload, "received");
    void handlePttIpcCaptureStart(payload);
  }

  function onPttIpcKeyUp(payload: DesktopPttEventPayload): void {
    if (!adapter.state.pttModeEnabled) {
      reportPttEvent(payload, "ignored", "ptt mode disabled");
      return;
    }
    console.info("[PTT] IPC keyup");
    reportPttEvent(payload, "received");
    void handlePttIpcCaptureStop(payload);
  }

  async function handlePttIpcCaptureStart(payload: DesktopPttEventPayload): Promise<void> {
    try {
      reportPttEvent(payload, await adapter.startPttCapture());
    } catch (error) {
      reportPttEvent(payload, "failed", getErrorMessage(error));
    }
  }

  async function handlePttIpcCaptureStop(payload: DesktopPttEventPayload): Promise<void> {
    try {
      reportPttEvent(payload, await adapter.stopPttCapture());
    } catch (error) {
      reportPttEvent(payload, "failed", getErrorMessage(error));
    }
  }

  function reportPttEvent(
    payload: DesktopPttEventPayload | undefined,
    status: DesktopPttAckStatus,
    message?: string,
  ): void {
    if (!payload) {
      return;
    }
    window.ag99desktop?.reportPttEventAck?.({
      eventId: payload.eventId,
      kind: payload.kind,
      status,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }

  let detachPttIpcKeyDown: (() => void) | undefined;
  let detachPttIpcKeyUp: (() => void) | undefined;
  let installed = false;

  function installPttIpcListeners(): void {
    const onIpc = window.ag99desktop?.onIpc as
      | ((channel: string, callback: (payload: DesktopPttEventPayload) => void) => () => void)
      | undefined;
    detachPttIpcKeyDown = onIpc?.(
      "desktop:ptt-keydown",
      (payload) => handlePttIpcPayload(payload, "keydown", onPttIpcKeyDown),
    );
    detachPttIpcKeyUp = onIpc?.(
      "desktop:ptt-keyup",
      (payload) => handlePttIpcPayload(payload, "keyup", onPttIpcKeyUp),
    );
  }

  function handlePttIpcPayload(
    payload: DesktopPttEventPayload,
    expectedKind: DesktopPttEventKind,
    handler: (payload: DesktopPttEventPayload) => void,
  ): void {
    if (!isDesktopPttEventPayload(payload) || payload.kind !== expectedKind) {
      return;
    }
    handler(payload);
  }

  function isDesktopPttEventPayload(value: unknown): value is DesktopPttEventPayload {
    if (!value || typeof value !== "object") {
      return false;
    }

    const raw = value as Partial<DesktopPttEventPayload>;
    return (
      typeof raw.eventId === "string"
      && (raw.kind === "keydown" || raw.kind === "keyup")
      && typeof raw.keycode === "number"
      && typeof raw.createdAt === "string"
    );
  }

  function removePttIpcListeners(): void {
    detachPttIpcKeyDown?.();
    detachPttIpcKeyUp?.();
    detachPttIpcKeyDown = undefined;
    detachPttIpcKeyUp = undefined;
  }

  function install(): void {
    if (installed) {
      return;
    }
    installed = true;
    installPttKeyboardListeners();
    installPttIpcListeners();
  }

  function dispose(): void {
    if (!installed) {
      return;
    }
    installed = false;
    removePttKeyboardListeners();
    removePttIpcListeners();
  }

  return {
    install,
    dispose,
  };
}
