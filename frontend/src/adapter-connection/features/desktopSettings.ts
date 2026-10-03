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
  currentDesktopScreenshotOnSendEnabled: () => boolean;
  applyDesktopScreenshotOnSendEnabled: (enabled: boolean) => void;
  currentPttModeEnabled: () => boolean;
  applyPttModeEnabled: (enabled: boolean) => void;
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

async function microphoneDeviceOptions(): Promise<SystemDesktopSettingOption[]> {
  const devices = await listMicrophoneInputDevices({ requestPermission: true });
  return devices.map((device) => ({ id: device.deviceId, label: device.label }));
}

function microphoneDeviceHandler(access: DesktopSettingAccess): DesktopSettingHandler {
  return {
    list: async () => ({
      value: access.currentMicrophoneDeviceId(),
      options: await microphoneDeviceOptions(),
    }),
    set: async (value) => {
      const options = await microphoneDeviceOptions();
      if (!options.some((option) => option.id === value)) {
        throw new Error("desktop_setting_value_not_available");
      }
      access.applyMicrophoneDevice(value);
      return { value, options };
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
  desktop_screenshot_on_send: (access) => booleanSettingHandler(
    access.currentDesktopScreenshotOnSendEnabled,
    access.applyDesktopScreenshotOnSendEnabled,
  ),
  ptt_mode_enabled: (access) => booleanSettingHandler(
    access.currentPttModeEnabled,
    access.applyPttModeEnabled,
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
