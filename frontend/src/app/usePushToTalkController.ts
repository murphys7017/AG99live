import type {
  DesktopPttAckStatus,
  DesktopPttEventKind,
  DesktopPttEventPayload,
  DesktopPttKeyBinding,
  DesktopPttHookStatus,
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
  let pressedKeycode: number | null = null;
  let domPressedCode: string | null = null;
  let useGlobalPtt = false;
  let hookStatusGeneration = 0;
  function onPttKeyDown(event: KeyboardEvent): void {
    if (useGlobalPtt) return;
    console.info("[PTT] keydown key=%s repeat=%s pttMode=%s", event.key, event.repeat, adapter.state.pttModeEnabled);
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    if (matchesPttKeyBinding(event, adapter.state.pttKeyBinding) && !event.repeat && domPressedCode === null) {
      domPressedCode = event.code;
      console.info("[PTT] starting mic capture");
      void adapter.startPttCapture();
    }
  }

  function onPttKeyUp(event: KeyboardEvent): void {
    if (useGlobalPtt || domPressedCode !== event.code) return;
    domPressedCode = null;
    console.info("[PTT] keyup key=%s pttMode=%s", event.key, adapter.state.pttModeEnabled);
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    console.info("[PTT] stopping mic capture");
    void adapter.stopPttCapture();
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
    if (!useGlobalPtt) {
      reportPttEvent(payload, "ignored", "foreground keyboard owns PTT");
      return;
    }
    if (!adapter.state.pttModeEnabled) {
      reportPttEvent(payload, "ignored", "ptt mode disabled");
      return;
    }
    if (pressedKeycode !== null || payload.keycode !== adapter.state.pttKeyBinding.uiohookKeycode) {
      reportPttEvent(payload, "ignored", "duplicate or unmatched keydown");
      return;
    }
    pressedKeycode = payload.keycode;
    console.info("[PTT] IPC keydown");
    reportPttEvent(payload, "received");
    void handlePttIpcCaptureStart(payload);
  }

  function onPttIpcKeyUp(payload: DesktopPttEventPayload): void {
    if (!useGlobalPtt) {
      reportPttEvent(payload, "ignored", "foreground keyboard owns PTT");
      return;
    }
    if (pressedKeycode !== payload.keycode) {
      reportPttEvent(payload, "ignored", "keyup without matching press");
      return;
    }
    pressedKeycode = null;
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

  async function handlePttIpcCaptureStop(payload: DesktopPttEventPayload): Promise<DesktopPttAckStatus> {
    try {
      const status = await adapter.stopPttCapture();
      reportPttEvent(payload, status);
      return status;
    } catch (error) {
      reportPttEvent(payload, "failed", getErrorMessage(error));
      return "failed";
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
  let detachPttHookStatus: (() => void) | undefined;
  let installed = false;

  function selectKeyboardSource(status: DesktopPttHookStatus): void {
    if (!installed) return;
    const globalEnabled = status.available && status.enabled && status.keycode !== null;
    if (globalEnabled === useGlobalPtt) return;
    useGlobalPtt = globalEnabled;
    if (pressedKeycode !== null || domPressedCode !== null) {
      pressedKeycode = null;
      domPressedCode = null;
      void adapter.stopPttCapture().catch((error: unknown) => {
        console.error("[PTT] failed to release capture on keyboard source change", error);
      });
    }
  }

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
    // Exactly one source is admitted. Foreground keys remain usable if the
    // native hook is unavailable or the binding has no native keycode.
    if (window.ag99desktop?.onIpc) {
      useGlobalPtt = true;
      installPttIpcListeners();
      detachPttHookStatus = window.ag99desktop.onPttHookStatus?.((status) => {
        hookStatusGeneration += 1;
        selectKeyboardSource(status);
      });
      const generation = hookStatusGeneration;
      void window.ag99desktop.getPttHookStatus?.().then((status) => {
        if (generation === hookStatusGeneration) selectKeyboardSource(status);
      }).catch((error: unknown) => {
        console.warn("[PTT] could not read global hook status", error);
      });
    } else {
      useGlobalPtt = false;
    }
  }

  function dispose(): void {
    if (!installed) {
      return;
    }
    installed = false;
    pressedKeycode = null;
    domPressedCode = null;
    hookStatusGeneration += 1;
    detachPttHookStatus?.();
    detachPttHookStatus = undefined;
    removePttKeyboardListeners();
    removePttIpcListeners();
  }

  return {
    install,
    dispose,
  };
}
