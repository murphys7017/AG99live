import { reactive, watch } from "vue";
import {
  ESP32_DISPLAY_DEFAULT_CONFIG,
  cloneConfig,
  normalizeConfig,
  type Esp32DisplayConfig,
} from "./types";

const STORAGE_KEY = "ag99live.esp32-display.config.v1";
const CHANNEL_NAME = "ag99live.esp32-display.config";
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

interface Esp32DisplayConfigMessage {
  source: string;
  config: Esp32DisplayConfig;
}

function loadFromStorage(): Esp32DisplayConfig {
  if (typeof window === "undefined") {
    return cloneConfig(ESP32_DISPLAY_DEFAULT_CONFIG);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...ESP32_DISPLAY_DEFAULT_CONFIG };
    }
    const parsed = JSON.parse(raw) as unknown;
    return {
      ...normalizeConfig(parsed as Partial<Esp32DisplayConfig>),
      enabled: false,
    };
  } catch (error) {
    console.warn("[Esp32Display] failed to load settings, using defaults.", error);
    return cloneConfig(ESP32_DISPLAY_DEFAULT_CONFIG);
  }
}

function persistToStorage(config: Esp32DisplayConfig): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...config,
      crop: { ...config.crop },
      enabled: false,
    }));
  } catch (error) {
    console.warn("[Esp32Display] failed to persist settings.", error);
  }
}

function applyConfig(target: Esp32DisplayConfig, source: Esp32DisplayConfig): void {
  target.enabled = source.enabled;
  target.host = source.host;
  target.port = source.port;
  target.fps = source.fps;
  target.jpegQuality = source.jpegQuality;
  target.outputSize = source.outputSize;
  target.scaleMode = source.scaleMode;
  target.crop.x = source.crop.x;
  target.crop.y = source.crop.y;
  target.crop.w = source.crop.w;
  target.crop.h = source.crop.h;
}

function parseConfigMessage(value: unknown): Esp32DisplayConfigMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as Partial<Esp32DisplayConfigMessage>;
  if (typeof payload.source !== "string") {
    return null;
  }
  return {
    source: payload.source,
    config: normalizeConfig(payload.config as Partial<Esp32DisplayConfig>),
  };
}

let singleton: ReturnType<typeof createSettings> | null = null;

function createSettings() {
  const config = reactive<Esp32DisplayConfig>(loadFromStorage());
  const channel = typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;
  let suppressNextPublish = false;

  watch(
    config,
    (next) => {
      if (suppressNextPublish) {
        suppressNextPublish = false;
        return;
      }
      persistToStorage(next);
      channel?.postMessage({
        source: INSTANCE_ID,
        config: cloneConfig(next),
      } satisfies Esp32DisplayConfigMessage);
    },
    { deep: true },
  );

  channel?.addEventListener("message", (event) => {
    const message = parseConfigMessage(event.data);
    if (!message || message.source === INSTANCE_ID) {
      return;
    }
    suppressNextPublish = true;
    applyConfig(config, message.config);
  });

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) {
        return;
      }
      try {
        const next = {
          ...normalizeConfig(JSON.parse(event.newValue) as Partial<Esp32DisplayConfig>),
          enabled: config.enabled,
        };
        suppressNextPublish = true;
        applyConfig(config, next);
      } catch (error) {
        console.warn("[Esp32Display] failed to apply storage update.", error);
      }
    });
  }

  function reset(): void {
    applyConfig(config, cloneConfig(ESP32_DISPLAY_DEFAULT_CONFIG));
  }

  return {
    config,
    reset,
  };
}

export function useEsp32DisplaySettings() {
  if (!singleton) {
    singleton = createSettings();
  }
  return singleton;
}
