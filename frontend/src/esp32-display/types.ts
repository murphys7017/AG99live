export interface Esp32DisplayCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Esp32DisplayConfig {
  enabled: boolean;
  host: string;
  port: number;
  crop: Esp32DisplayCrop;
  fps: number;
  jpegQuality: number;
  outputSize: number;
  scaleMode: Esp32DisplayScaleMode;
}

export type Esp32DisplayStatus =
  | { kind: "idle" }
  | { kind: "connecting"; host: string; port: number }
  | { kind: "connected"; host: string; port: number }
  | { kind: "disconnected"; reason: string }
  | { kind: "error"; message: string };

export const ESP32_DISPLAY_DEFAULT_CROP: Esp32DisplayCrop = {
  x: 0,
  y: 0,
  w: 1,
  h: 1,
};

export const ESP32_DISPLAY_DEFAULT_CONFIG: Esp32DisplayConfig = {
  enabled: false,
  host: "192.168.5.7",
  port: 8081,
  crop: { ...ESP32_DISPLAY_DEFAULT_CROP },
  fps: 24,
  jpegQuality: 0.75,
  outputSize: 240,
  scaleMode: "cover",
};

export const ESP32_DISPLAY_FPS_OPTIONS = [1, 2, 4, 8, 12, 24] as const;
export const ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS = [120, 160, 200, 240, 320] as const;
export const ESP32_DISPLAY_SCALE_MODE_OPTIONS = ["cover", "contain", "stretch"] as const;

export type Esp32DisplayFps = (typeof ESP32_DISPLAY_FPS_OPTIONS)[number];
export type Esp32DisplayOutputSize = (typeof ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS)[number];
export type Esp32DisplayScaleMode = (typeof ESP32_DISPLAY_SCALE_MODE_OPTIONS)[number];

export function isEsp32DisplayFps(value: number): value is Esp32DisplayFps {
  return (ESP32_DISPLAY_FPS_OPTIONS as readonly number[]).includes(value);
}

export function isEsp32DisplayOutputSize(value: number): value is Esp32DisplayOutputSize {
  return (ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS as readonly number[]).includes(value);
}

export function isEsp32DisplayScaleMode(value: unknown): value is Esp32DisplayScaleMode {
  return typeof value === "string"
    && (ESP32_DISPLAY_SCALE_MODE_OPTIONS as readonly string[]).includes(value);
}

export function normalizeCrop(crop: Partial<Esp32DisplayCrop> | undefined): Esp32DisplayCrop {
  const fallback = ESP32_DISPLAY_DEFAULT_CROP;
  if (!crop) {
    return { ...fallback };
  }
  const clamp = (v: unknown, fallbackValue: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      return fallbackValue;
    }
    return Math.min(1, Math.max(0, n));
  };
  const w = Math.max(0.05, clamp(crop.w, fallback.w));
  const h = Math.max(0.05, clamp(crop.h, fallback.h));
  return {
    x: Math.min(1 - w, clamp(crop.x, fallback.x)),
    y: Math.min(1 - h, clamp(crop.y, fallback.y)),
    w,
    h,
  };
}

export function normalizeConfig(input: Partial<Esp32DisplayConfig> | undefined): Esp32DisplayConfig {
  const fallback = ESP32_DISPLAY_DEFAULT_CONFIG;
  const enabled = Boolean(input?.enabled);
  const host = typeof input?.host === "string" && input.host.trim().length > 0
    ? input.host.trim()
    : fallback.host;
  const port = Number(input?.port);
  const fps = Number(input?.fps);
  const quality = Number(input?.jpegQuality);
  const outputSize = Number(input?.outputSize);
  const scaleMode = input?.scaleMode;
  return {
    enabled,
    host,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.round(port) : fallback.port,
    crop: normalizeCrop(input?.crop),
    fps: isEsp32DisplayFps(fps) ? fps : fallback.fps,
    jpegQuality: Number.isFinite(quality) && quality > 0 && quality <= 1
      ? quality
      : fallback.jpegQuality,
    outputSize: isEsp32DisplayOutputSize(outputSize)
      ? outputSize
      : fallback.outputSize,
    scaleMode: isEsp32DisplayScaleMode(scaleMode)
      ? scaleMode
      : fallback.scaleMode,
  };
}

export function cloneConfig(config: Esp32DisplayConfig): Esp32DisplayConfig {
  return {
    ...config,
    crop: { ...config.crop },
  };
}
