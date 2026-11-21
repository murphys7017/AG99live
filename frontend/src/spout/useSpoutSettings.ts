import { reactive, watch } from "vue";

const STORAGE_KEY = "ag99live.spout.config.v1";
const CHANNEL_NAME = "ag99live.spout.config";
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export interface SpoutConfig {
  enabled: boolean;
  fps: number;
  scale: number;
}

const DEFAULT_CONFIG: SpoutConfig = {
  enabled: false,
  fps: 30,
  scale: 1,
};

interface SpoutConfigMessage {
  source: string;
  config: SpoutConfig;
}

function cloneConfig(config: Partial<SpoutConfig>): SpoutConfig {
  return {
    enabled: config.enabled === true,
    fps: config.fps === 15 || config.fps === 24 ? config.fps : 30,
    scale: config.scale === 0.5 ? 0.5 : 1,
  };
}

function loadConfig(): SpoutConfig {
  if (typeof window === "undefined") {
    return cloneConfig(DEFAULT_CONFIG);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return cloneConfig(DEFAULT_CONFIG);
    }
    const parsed = JSON.parse(raw) as Partial<SpoutConfig>;
    return cloneConfig(parsed);
  } catch (error) {
    console.warn("[Spout] failed to load settings, using defaults.", error);
    return cloneConfig(DEFAULT_CONFIG);
  }
}

function parseMessage(value: unknown): SpoutConfigMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as Partial<SpoutConfigMessage>;
  if (typeof payload.source !== "string" || !payload.config || typeof payload.config !== "object") {
    return null;
  }
  return {
    source: payload.source,
    config: cloneConfig(payload.config),
  };
}

let singleton: ReturnType<typeof createSettings> | null = null;

function createSettings() {
  const config = reactive<SpoutConfig>(loadConfig());
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
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cloneConfig(next)));
        } catch (error) {
          console.warn("[Spout] failed to persist settings.", error);
        }
      }
      channel?.postMessage({
        source: INSTANCE_ID,
        config: cloneConfig(next),
      } satisfies SpoutConfigMessage);
    },
    { deep: true },
  );

  function applyRemote(next: SpoutConfig): void {
    if (config.enabled === next.enabled && config.fps === next.fps && config.scale === next.scale) return;
    suppressNextPublish = true;
    Object.assign(config, next);
  }

  channel?.addEventListener("message", (event) => {
    const message = parseMessage(event.data);
    if (!message || message.source === INSTANCE_ID) {
      return;
    }
    applyRemote(message.config);
  });

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) {
        return;
      }
      try {
        const next = JSON.parse(event.newValue) as Partial<SpoutConfig>;
        applyRemote(cloneConfig(next));
      } catch (error) {
        console.warn("[Spout] failed to apply storage update.", error);
      }
    });
  }

  function reset(): void {
    config.enabled = DEFAULT_CONFIG.enabled;
  }

  return { config, reset };
}

export function useSpoutSettings() {
  if (!singleton) {
    singleton = createSettings();
  }
  return singleton;
}
