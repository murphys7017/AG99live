/**
 * Desktop-local setting responder.
 *
 * The adapter only forwards requests. Values and options come from the
 * connected desktop, which owns the corresponding runtime and persistence.
 */

import type {
  ProtocolEnvelope,
  SystemDesktopSettingOption,
  SystemDesktopSettingsQueryPayload,
  SystemDesktopSettingsResultPayload,
} from "../../types/protocol.js";
import {
  ESP32_DISPLAY_FPS_OPTIONS,
  ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS,
  ESP32_DISPLAY_SCALE_MODE_OPTIONS,
  cloneConfig,
  isEsp32DisplayFps,
  isEsp32DisplayOutputSize,
  isEsp32DisplayScaleMode,
  type Esp32DisplayConfig,
} from "../../esp32-display/types.js";
import { listMicrophoneInputDevices } from "../runtime/microphoneDevices.js";
import {
  normalizePttKeyBinding,
} from "../core/pttKeyBinding.js";
import type { DesktopPttKeyBinding } from "../../types/desktop.js";
import {
  MAX_MODEL_VIEW_SCALE,
  MIN_MODEL_VIEW_SCALE,
} from "../../app/petPreferences.js";
import {
  normalizeBilibiliLiveSettings,
} from "../../bilibili-live/settings.js";
import type { BilibiliLiveSettings } from "../../types/bilibili-live.js";
import { normalizeAdapterAddressSetting } from "../core/preferences.js";
import { normalizeAstrbotWebUiUrl } from "../../app/webControlUrl.js";
import {
  loadCursorGazeSettings,
  saveCursorGazeSetting,
} from "../../app/cursorGazeSettings.js";
import {
  MAX_LIVE2D_RENDER_DPR_CAP,
  MAX_PHYSICS_RESPONSE_SCALE,
  MIN_LIVE2D_RENDER_DPR_CAP,
  MIN_PHYSICS_RESPONSE_SCALE,
  LIVE2D_RENDER_DPR_CAP_STEP,
  PHYSICS_RESPONSE_SCALE_STEP,
} from "../../live2d-renderer/settings.js";
import {
  MAX_MOTION_INTENSITY_SCALE,
  MIN_MOTION_INTENSITY_SCALE,
  MOTION_INTENSITY_SCALE_STEP,
} from "../../model-engine/settings.js";

export interface DesktopSettingEntry {
  value: string;
  options: SystemDesktopSettingOption[];
  minimum?: number;
  maximum?: number;
  step?: number;
}

export interface DesktopRuntimeSettingsAccess {
  currentAmbientMotionEnabled: () => boolean;
  applyAmbientMotionEnabled: (enabled: boolean) => void;
  currentPhysicsResponseScale: () => number;
  applyPhysicsResponseScale: (scale: number) => void;
  currentRenderDprCap: () => number;
  applyRenderDprCap: (cap: number) => void;
  currentMotionIntensityScale: () => number;
  applyMotionIntensityScale: (scale: number) => void;
}

/** Desktop-local state this responder reads and mutates. */
export interface DesktopSettingAccess {
  currentAdapterAddress: () => string;
  applyAdapterAddress: (address: string) => void;
  currentDesktopScreenshotOnSendEnabled: () => boolean;
  applyDesktopScreenshotOnSendEnabled: (enabled: boolean) => void;
  currentPttModeEnabled: () => boolean;
  applyPttModeEnabled: (enabled: boolean) => void;
  currentPttKeyBinding: () => DesktopPttKeyBinding;
  applyPttKeyBinding: (binding: DesktopPttKeyBinding) => void;
  currentSpeechVolume: () => number;
  applySpeechVolume: (volume: number) => void;
  currentModelViewScale: () => number;
  applyModelViewScale: (scale: number) => void;
  currentBilibiliLiveSettings: () => BilibiliLiveSettings;
  applyBilibiliLiveSettings: (settings: BilibiliLiveSettings) => void;
  runtimeSettings: DesktopRuntimeSettingsAccess;
  currentMicrophoneDeviceId: () => string;
  applyMicrophoneDevice: (deviceId: string) => void;
  currentSpoutEnabled: () => boolean;
  applySpoutEnabled: (enabled: boolean) => void;
  currentEsp32DisplayConfig: () => Esp32DisplayConfig;
  applyEsp32DisplayConfig: (config: Esp32DisplayConfig) => Promise<void>;
}

interface DesktopSettingHandler {
  list: () => Promise<DesktopSettingEntry>;
  set: (value: string) => Promise<DesktopSettingEntry>;
}

const DEFAULT_MICROPHONE_OPTION_ID = "system-default";

async function microphoneDeviceOptions(): Promise<SystemDesktopSettingOption[]> {
  const devices = await listMicrophoneInputDevices({ requestPermission: false });
  return [
    { id: DEFAULT_MICROPHONE_OPTION_ID, label: "系统默认麦克风" },
    ...devices.map((device) => ({ id: device.deviceId, label: device.label })),
  ];
}

function webControlUrlHandler(): DesktopSettingHandler {
  const desktop = window.ag99desktop;
  if (!desktop) throw new Error("desktop_setting_unsupported");
  return {
    list: async () => ({ value: await desktop.getWebControlUrl(), options: [] }),
    set: async (value) => {
      const normalized = normalizeAstrbotWebUiUrl(value);
      try {
        return { value: await desktop.setWebControlUrl(normalized), options: [] };
      } catch {
        throw new Error("astrbot_webui_url_save_failed");
      }
    },
  };
}

function microphoneDeviceHandler(access: DesktopSettingAccess): DesktopSettingHandler {
  const currentValue = () => access.currentMicrophoneDeviceId() || DEFAULT_MICROPHONE_OPTION_ID;
  return {
    list: async () => ({
      value: currentValue(),
      options: await microphoneDeviceOptions(),
    }),
    set: async (value) => {
      const options = await microphoneDeviceOptions();
      if (!options.some((option) => option.id === value)) {
        throw new Error("desktop_setting_value_not_available");
      }
      access.applyMicrophoneDevice(value === DEFAULT_MICROPHONE_OPTION_ID ? "" : value);
      return { value: currentValue(), options };
    },
  };
}

function booleanSettingHandler(
  current: () => boolean,
  apply: (enabled: boolean) => void,
): DesktopSettingHandler {
  return {
    list: async () => ({ value: String(current()), options: [] }),
    set: async (value) => {
      if (value !== "true" && value !== "false") {
        throw new Error("desktop_setting_value_invalid");
      }
      const enabled = value === "true";
      apply(enabled);
      return { value: String(current()), options: [] };
    },
  };
}

function boundedNumberSettingHandler(
  current: () => number,
  apply: (value: number) => void,
  minimum: number,
  maximum: number,
  step: number,
): DesktopSettingHandler {
  return {
    list: async () => ({
      value: String(current()),
      options: [],
      minimum,
      maximum,
      step,
    }),
    set: async (value) => {
      const parsed = parseFiniteNumber(value);
      if (parsed < minimum || parsed > maximum) {
        throw new Error("desktop_setting_value_out_of_range");
      }
      apply(parsed);
      return {
        value: String(current()),
        options: [],
        minimum,
        maximum,
        step,
      };
    },
  };
}

function textSettingHandler(
  current: () => string,
  apply: (value: string) => void,
  normalize: (value: string) => string = (value) => value.trim(),
  allowEmpty = false,
): DesktopSettingHandler {
  return {
    list: async () => ({ value: current(), options: [] }),
    set: async (value) => {
      const normalized = normalize(value);
      if ((!allowEmpty && !normalized) || normalized.length > 255) {
        throw new Error("desktop_setting_value_invalid");
      }
      apply(normalized);
      return { value: current(), options: [] };
    },
  };
}

function pttKeyBindingHandler(access: DesktopSettingAccess): DesktopSettingHandler {
  return {
    list: async () => ({
      value: JSON.stringify(normalizePttKeyBinding(access.currentPttKeyBinding())),
      options: [],
    }),
    set: async (value) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error("desktop_setting_value_invalid");
      }
      if (
        !parsed
        || typeof parsed !== "object"
        || Array.isArray(parsed)
        || typeof (parsed as { code?: unknown }).code !== "string"
        || !(parsed as { code: string }).code.trim()
      ) {
        throw new Error("desktop_setting_value_invalid");
      }
      const binding = normalizePttKeyBinding({
        code: (parsed as { code: string }).code.trim(),
      });
      if (!binding.code || binding.uiohookKeycode === null) {
        throw new Error("desktop_setting_value_invalid");
      }
      access.applyPttKeyBinding(binding);
      return {
        value: JSON.stringify(normalizePttKeyBinding(access.currentPttKeyBinding())),
        options: [],
      };
    },
  };
}

const BILIBILI_COOKIE_MASK = "••••••";

function bilibiliSettingHandler(
  access: DesktopSettingAccess,
  key: string,
): DesktopSettingHandler {
  const read = (settings: BilibiliLiveSettings): string => {
    switch (key) {
      case "bilibili_live_enabled": return String(settings.enabled);
      case "bilibili_live_room_id": return settings.roomId;
      case "bilibili_live_cookie": return settings.cookie ? BILIBILI_COOKIE_MASK : "";
      case "bilibili_live_response_interval": return String(settings.responseIntervalSeconds);
      default: throw new Error("desktop_setting_unsupported");
    }
  };
  const options: SystemDesktopSettingOption[] = [];
  const bounds = key === "bilibili_live_response_interval"
    ? { minimum: 5, maximum: 600, step: 1 }
    : {};
  return {
    list: async () => ({ value: read(access.currentBilibiliLiveSettings()), options, ...bounds }),
    set: async (value) => {
      const settings = normalizeBilibiliLiveSettings(access.currentBilibiliLiveSettings());
      switch (key) {
        case "bilibili_live_enabled":
          if (value !== "true" && value !== "false") throw new Error("desktop_setting_value_invalid");
          settings.enabled = value === "true";
          break;
        case "bilibili_live_room_id":
          if (!value.trim()) {
            settings.roomId = "";
          } else {
            settings.roomId = normalizeBilibiliLiveSettings({ roomId: value }).roomId;
            if (!settings.roomId) throw new Error("desktop_setting_value_invalid");
          }
          break;
        case "bilibili_live_cookie":
          if (value !== BILIBILI_COOKIE_MASK) settings.cookie = value.trim();
          break;
        case "bilibili_live_response_interval": {
          const interval = parseInteger(value);
          if (interval < 5 || interval > 600) throw new Error("desktop_setting_value_out_of_range");
          settings.responseIntervalSeconds = interval;
          break;
        }
        default: throw new Error("desktop_setting_unsupported");
      }
      access.applyBilibiliLiveSettings(settings);
      return { value: read(access.currentBilibiliLiveSettings()), options, ...bounds };
    },
  };
}

function readEsp32DisplayValue(
  key: string,
  config: Esp32DisplayConfig,
): string {
  switch (key) {
    case "esp32_display_enabled": return String(config.enabled);
    case "esp32_display_host": return config.host;
    case "esp32_display_port": return String(config.port);
    case "esp32_display_fps": return String(config.fps);
    case "esp32_display_jpeg_quality": return String(config.jpegQuality);
    case "esp32_display_output_size": return String(config.outputSize);
    case "esp32_display_scale_mode": return config.scaleMode;
    case "esp32_display_crop_x": return String(config.crop.x);
    case "esp32_display_crop_y": return String(config.crop.y);
    case "esp32_display_crop_w": return String(config.crop.w);
    case "esp32_display_crop_h": return String(config.crop.h);
    default: throw new Error("desktop_setting_unsupported");
  }
}

function esp32DisplayOptions(key: string): SystemDesktopSettingOption[] {
  switch (key) {
    case "esp32_display_fps":
      return ESP32_DISPLAY_FPS_OPTIONS.map((value) => ({
        id: String(value),
        label: `${value} fps`,
      }));
    case "esp32_display_output_size":
      return ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS.map((value) => ({
        id: String(value),
        label: `${value} x ${value}`,
      }));
    case "esp32_display_scale_mode":
      return ESP32_DISPLAY_SCALE_MODE_OPTIONS.map((value) => ({
        id: value,
        label: ({ cover: "填满", contain: "完整", stretch: "拉伸" })[value],
      }));
    default:
      return [];
  }
}

function parseFiniteNumber(value: string): number {
  if (!value.trim()) {
    throw new Error("desktop_setting_value_invalid");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("desktop_setting_value_invalid");
  }
  return parsed;
}

function parseInteger(value: string): number {
  const parsed = parseFiniteNumber(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("desktop_setting_value_invalid");
  }
  return parsed;
}

function esp32DisplaySettingHandler(
  access: DesktopSettingAccess,
  key: string,
): DesktopSettingHandler {
  const options = esp32DisplayOptions(key);
  const bounds = (config: Esp32DisplayConfig) => {
    switch (key) {
      case "esp32_display_crop_x": return { minimum: 0, maximum: 1 - config.crop.w, step: 0.01 };
      case "esp32_display_crop_y": return { minimum: 0, maximum: 1 - config.crop.h, step: 0.01 };
      case "esp32_display_crop_w": return { minimum: 0.05, maximum: 1 - config.crop.x, step: 0.01 };
      case "esp32_display_crop_h": return { minimum: 0.05, maximum: 1 - config.crop.y, step: 0.01 };
      case "esp32_display_port": return { minimum: 1, maximum: 65535, step: 1 };
      case "esp32_display_jpeg_quality": return { minimum: 0.01, maximum: 1, step: 0.01 };
      default: return {};
    }
  };

  return {
    list: async () => {
      const config = access.currentEsp32DisplayConfig();
      return {
        value: readEsp32DisplayValue(key, config),
        options,
        ...bounds(config),
      };
    },
    set: async (value) => {
      const config = cloneConfig(access.currentEsp32DisplayConfig());
      switch (key) {
        case "esp32_display_enabled":
          if (value !== "true" && value !== "false") {
            throw new Error("desktop_setting_value_invalid");
          }
          config.enabled = value === "true";
          break;
        case "esp32_display_host":
          if (!value.trim() || value.trim().length > 255) {
            throw new Error("desktop_setting_value_invalid");
          }
          config.host = value.trim();
          break;
        case "esp32_display_port": {
          const port = parseInteger(value);
          if (port < 1 || port > 65535) {
            throw new Error("desktop_setting_value_out_of_range");
          }
          config.port = port;
          break;
        }
        case "esp32_display_fps": {
          const fps = parseInteger(value);
          if (!isEsp32DisplayFps(fps)) {
            throw new Error("desktop_setting_value_not_available");
          }
          config.fps = fps;
          break;
        }
        case "esp32_display_jpeg_quality": {
          const quality = parseFiniteNumber(value);
          if (quality < 0.01 || quality > 1) {
            throw new Error("desktop_setting_value_out_of_range");
          }
          config.jpegQuality = quality;
          break;
        }
        case "esp32_display_output_size": {
          const size = parseInteger(value);
          if (!isEsp32DisplayOutputSize(size)) {
            throw new Error("desktop_setting_value_not_available");
          }
          config.outputSize = size;
          break;
        }
        case "esp32_display_scale_mode":
          if (!isEsp32DisplayScaleMode(value)) {
            throw new Error("desktop_setting_value_not_available");
          }
          config.scaleMode = value;
          break;
        case "esp32_display_crop_x":
        case "esp32_display_crop_y":
        case "esp32_display_crop_w":
        case "esp32_display_crop_h": {
          const next = parseFiniteNumber(value);
          const minimum = key.endsWith("_w") || key.endsWith("_h") ? 0.05 : 0;
          if (next < minimum || next > 1) {
            throw new Error("desktop_setting_value_out_of_range");
          }
          if (key.endsWith("_x")) config.crop.x = next;
          if (key.endsWith("_y")) config.crop.y = next;
          if (key.endsWith("_w")) config.crop.w = next;
          if (key.endsWith("_h")) config.crop.h = next;
          if (config.crop.x + config.crop.w > 1 || config.crop.y + config.crop.h > 1) {
            throw new Error("desktop_setting_value_out_of_range");
          }
          break;
        }
        default:
          throw new Error("desktop_setting_unsupported");
      }

      await access.applyEsp32DisplayConfig(config);
      const applied = access.currentEsp32DisplayConfig();
      return {
        value: readEsp32DisplayValue(key, applied),
        options,
        ...bounds(applied),
      };
    },
  };
}

const ESP32_SETTING_KEYS = [
  "esp32_display_enabled",
  "esp32_display_host",
  "esp32_display_port",
  "esp32_display_fps",
  "esp32_display_jpeg_quality",
  "esp32_display_output_size",
  "esp32_display_scale_mode",
  "esp32_display_crop_x",
  "esp32_display_crop_y",
  "esp32_display_crop_w",
  "esp32_display_crop_h",
] as const;
const ESP32_SETTING_KEY_SET: ReadonlySet<string> = new Set(ESP32_SETTING_KEYS);

const DESKTOP_SETTING_HANDLERS: Record<
  string,
  (access: DesktopSettingAccess) => DesktopSettingHandler
> = {
  astrbot_webui_url: webControlUrlHandler,
  cursor_gaze_enabled: () => booleanSettingHandler(
    () => loadCursorGazeSettings().enabled,
    (enabled) => { saveCursorGazeSetting("enabled", enabled); },
  ),
  cursor_gaze_poll_interval_ms: () => boundedNumberSettingHandler(
    () => loadCursorGazeSettings().pollIntervalMs,
    (value) => { saveCursorGazeSetting("pollIntervalMs", value); },
    50,
    1000,
    10,
  ),
  cursor_gaze_dwell_ms: () => boundedNumberSettingHandler(
    () => loadCursorGazeSettings().dwellMs,
    (value) => { saveCursorGazeSetting("dwellMs", value); },
    100,
    2000,
    50,
  ),
  cursor_gaze_stationary_distance_px: () => boundedNumberSettingHandler(
    () => loadCursorGazeSettings().stationaryDistancePx,
    (value) => { saveCursorGazeSetting("stationaryDistancePx", value); },
    1,
    100,
    1,
  ),
  adapter_address: (access) => textSettingHandler(
    access.currentAdapterAddress,
    (value) => access.applyAdapterAddress(normalizeAdapterAddressSetting(value)),
    normalizeAdapterAddressSetting,
    true,
  ),
  desktop_screenshot_on_send: (access) => booleanSettingHandler(
    access.currentDesktopScreenshotOnSendEnabled,
    access.applyDesktopScreenshotOnSendEnabled,
  ),
  ptt_mode_enabled: (access) => booleanSettingHandler(
    access.currentPttModeEnabled,
    access.applyPttModeEnabled,
  ),
  ptt_key_binding: pttKeyBindingHandler,
  speech_volume: (access) => boundedNumberSettingHandler(
    access.currentSpeechVolume,
    access.applySpeechVolume,
    0,
    1,
    0.01,
  ),
  model_view_scale: (access) => boundedNumberSettingHandler(
    access.currentModelViewScale,
    access.applyModelViewScale,
    MIN_MODEL_VIEW_SCALE,
    MAX_MODEL_VIEW_SCALE,
    0.05,
  ),
  live2d_ambient_motion_enabled: (access) => booleanSettingHandler(
    access.runtimeSettings.currentAmbientMotionEnabled,
    access.runtimeSettings.applyAmbientMotionEnabled,
  ),
  live2d_physics_response_scale: (access) => boundedNumberSettingHandler(
    access.runtimeSettings.currentPhysicsResponseScale,
    access.runtimeSettings.applyPhysicsResponseScale,
    MIN_PHYSICS_RESPONSE_SCALE,
    MAX_PHYSICS_RESPONSE_SCALE,
    PHYSICS_RESPONSE_SCALE_STEP,
  ),
  live2d_render_dpr_cap: (access) => boundedNumberSettingHandler(
    access.runtimeSettings.currentRenderDprCap,
    access.runtimeSettings.applyRenderDprCap,
    MIN_LIVE2D_RENDER_DPR_CAP,
    MAX_LIVE2D_RENDER_DPR_CAP,
    LIVE2D_RENDER_DPR_CAP_STEP,
  ),
  motion_engine_intensity_scale: (access) => boundedNumberSettingHandler(
    access.runtimeSettings.currentMotionIntensityScale,
    access.runtimeSettings.applyMotionIntensityScale,
    MIN_MOTION_INTENSITY_SCALE,
    MAX_MOTION_INTENSITY_SCALE,
    MOTION_INTENSITY_SCALE_STEP,
  ),
  microphone_device: microphoneDeviceHandler,
  spout_enabled: (access) => booleanSettingHandler(
    access.currentSpoutEnabled,
    access.applySpoutEnabled,
  ),
};

for (const key of [
  "bilibili_live_enabled",
  "bilibili_live_room_id",
  "bilibili_live_cookie",
  "bilibili_live_response_interval",
]) {
  DESKTOP_SETTING_HANDLERS[key] = (access) => bilibiliSettingHandler(access, key);
}

for (const key of ESP32_SETTING_KEYS) {
  DESKTOP_SETTING_HANDLERS[key] = (access) => esp32DisplaySettingHandler(access, key);
}

export function createDesktopSettingsResponder(
  access: DesktopSettingAccess,
  send: (payload: SystemDesktopSettingsResultPayload) => void,
): (
  envelope: ProtocolEnvelope<SystemDesktopSettingsQueryPayload>,
) => Promise<void> {
  let esp32RequestQueue: Promise<void> = Promise.resolve();

  async function processDesktopSettingsQuery(
    envelope: ProtocolEnvelope<SystemDesktopSettingsQueryPayload>,
  ): Promise<void> {
    const { request_id: requestId, key, action, value } = envelope.payload;
    const createHandler = DESKTOP_SETTING_HANDLERS[key];
    if (!createHandler) {
      send({
        request_id: requestId,
        key,
        ok: false,
        error: "desktop_setting_unsupported",
      });
      return;
    }

    try {
      const handler = createHandler(access);
      const entry = action === "set"
        ? await handler.set(value ?? "")
        : await handler.list();
      send({
        request_id: requestId,
        key,
        ok: true,
        value: entry.value,
        options: entry.options,
        minimum: entry.minimum,
        maximum: entry.maximum,
        step: entry.step,
      });
    } catch (error) {
      send({
        request_id: requestId,
        key,
        ok: false,
        error: error instanceof Error ? error.message : "desktop_setting_failed",
      });
    }
  }

  return function handleDesktopSettingsQuery(
    envelope: ProtocolEnvelope<SystemDesktopSettingsQueryPayload>,
  ): Promise<void> {
    if (
      envelope.payload.action !== "set"
      || !ESP32_SETTING_KEY_SET.has(envelope.payload.key)
    ) {
      return processDesktopSettingsQuery(envelope);
    }
    // Queue the complete read-modify-apply operation so concurrent ESP32
    // field updates cannot each snapshot the same stale configuration.
    const current = esp32RequestQueue.then(
      () => processDesktopSettingsQuery(envelope),
      () => processDesktopSettingsQuery(envelope),
    );
    esp32RequestQueue = current.catch(() => undefined);
    return current;
  };
}
