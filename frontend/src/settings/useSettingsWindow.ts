import { computed, reactive, ref, watch } from "vue";
import { listMicrophoneInputDevices } from "../adapter-connection/runtime/microphoneDevices";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";
import { DEFAULT_ADAPTER_ADDRESS } from "../adapter-connection/core/address";
import {
  MAX_MOTION_INTENSITY_SCALE,
  MIN_MOTION_INTENSITY_SCALE,
  MOTION_INTENSITY_SCALE_STEP,
  cloneModelEngineSettings,
} from "../model-engine/settings";
import { applyMotionEngineSettingsSnapshot } from "../app/motionEngineSettingsSnapshot";

export function useSettingsWindow() {
  const bridge = useDesktopBridge();
  const draftAddress = ref(bridge.state.snapshot.adapterAddress);
  const desktopScreenshotOnSendEnabled = ref(
    bridge.state.snapshot.desktopScreenshotOnSendEnabled,
  );
  const microphoneDeviceId = ref(bridge.state.snapshot.microphoneDeviceId);
  const microphoneDeviceStatus = ref("");
  const ambientMotionEnabled = ref(bridge.state.snapshot.ambientMotionEnabled);
  const pttModeEnabled = ref(bridge.state.snapshot.pttModeEnabled);
  const motionEngineSettings = reactive(
    cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
  );

  watch(
    () => bridge.state.snapshot.adapterAddress,
    (nextValue) => {
      draftAddress.value = nextValue;
    },
  );

  watch(
    () => bridge.state.snapshot.desktopScreenshotOnSendEnabled,
    (nextValue) => {
      desktopScreenshotOnSendEnabled.value = nextValue;
    },
  );

  watch(
    () => bridge.state.snapshot.microphoneDeviceId,
    (nextValue) => {
      microphoneDeviceId.value = nextValue;
    },
  );

  watch(
    () => bridge.state.snapshot.ambientMotionEnabled,
    (nextValue) => {
      ambientMotionEnabled.value = nextValue;
    },
  );

  watch(
    () => bridge.state.snapshot.pttModeEnabled,
    (nextValue) => {
      pttModeEnabled.value = nextValue;
    },
  );

  watch(
    () => bridge.state.snapshot.motionEngineSettings,
    (nextValue) => {
      applyMotionEngineSettingsSnapshot(motionEngineSettings, nextValue);
    },
    { deep: true },
  );

  const statusLabel = computed(() => {
    if (bridge.state.snapshot.connectionState === "synced") {
      return "模型已同步";
    }
    if (bridge.state.snapshot.connectionState === "connecting") {
      return "连接中";
    }
    if (bridge.state.snapshot.connectionState === "error") {
      return "连接异常";
    }
    if (bridge.state.snapshot.connectionState === "linked") {
      return "适配器已连接";
    }
    return "尚未连接";
  });

  function applyAddress(): void {
    bridge.sendCommand({ type: "set_address", address: draftAddress.value });
  }

  function connectAdapter(): void {
    bridge.sendCommand({ type: "connect", address: draftAddress.value });
  }

  function disconnectAdapter(): void {
    bridge.sendCommand({ type: "disconnect" });
  }

  function toggleHistoryWindow(): void {
    window.ag99desktop?.toggleAuxWindow("history");
  }

  function toggleActionLabWindow(): void {
    window.ag99desktop?.toggleAuxWindow("action_lab");
  }

  function toggleProfileEditorWindow(): void {
    window.ag99desktop?.toggleAuxWindow("profile_editor");
  }

  function requestModelProjectionSync(): void {
    bridge.sendCommand({ type: "request_model_projection_sync" });
  }

  const profileEditorButtonLabel = computed(() =>
    bridge.state.windowState.profileEditorVisible
      ? "关闭 Profile Editor"
      : "打开 Profile Editor",
  );

  function applyDesktopScreenshotOnSend(): void {
    bridge.sendCommand({
      type: "set_desktop_screenshot_on_send",
      enabled: desktopScreenshotOnSendEnabled.value,
    });
  }

  function applyMicrophoneDevice(): void {
    bridge.sendCommand({
      type: "set_microphone_device",
      deviceId: microphoneDeviceId.value,
    });
  }

  async function refreshMicrophoneDevices(): Promise<void> {
    microphoneDeviceStatus.value = "正在刷新麦克风设备...";
    try {
      const devices = await listMicrophoneInputDevices({ requestPermission: true });
      bridge.sendCommand({ type: "set_microphone_devices", devices });
      microphoneDeviceStatus.value = devices.length
        ? `已发现 ${devices.length} 个麦克风设备。`
        : "没有发现可用的麦克风设备。";
    } catch (error) {
      const message = error instanceof Error ? error.message : "麦克风设备刷新失败。";
      microphoneDeviceStatus.value = `麦克风设备刷新失败：${message}`;
      console.warn("[SettingsWindow] failed to refresh microphone devices.", error);
    }
  }

  function applyAmbientMotionEnabled(): void {
    bridge.sendCommand({
      type: "set_ambient_motion_enabled",
      enabled: ambientMotionEnabled.value,
    });
  }

  function applyPttModeEnabled(): void {
    bridge.sendCommand({
      type: "set_ptt_mode",
      enabled: pttModeEnabled.value,
    });
  }

  function applyMotionEngineSettings(): void {
    bridge.sendCommand({
      type: "set_motion_engine_settings",
      settings: cloneModelEngineSettings(motionEngineSettings),
    });
  }

  function formatScale(value: unknown): string {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "1.00";
    }
    return numeric.toFixed(2);
  }

  function resetMotionEngineSettings(): void {
    applyMotionEngineSettingsSnapshot(motionEngineSettings, undefined);
    applyMotionEngineSettings();
  }

  return {
    bridgeState: bridge.state,
    draftAddress,
    desktopScreenshotOnSendEnabled,
    microphoneDeviceId,
    microphoneDeviceStatus,
    ambientMotionEnabled,
    pttModeEnabled,
    motionEngineSettings,
    statusLabel,
    profileEditorButtonLabel,
    defaultAdapterAddress: DEFAULT_ADAPTER_ADDRESS,
    motionIntensityMin: MIN_MOTION_INTENSITY_SCALE,
    motionIntensityMax: MAX_MOTION_INTENSITY_SCALE,
    motionIntensityStep: MOTION_INTENSITY_SCALE_STEP,
    applyAddress,
    connectAdapter,
    disconnectAdapter,
    toggleHistoryWindow,
    toggleActionLabWindow,
    toggleProfileEditorWindow,
    applyDesktopScreenshotOnSend,
    applyMicrophoneDevice,
    refreshMicrophoneDevices,
    applyAmbientMotionEnabled,
    applyPttModeEnabled,
    applyMotionEngineSettings,
    resetMotionEngineSettings,
    requestModelProjectionSync,
    formatScale,
  };
}
