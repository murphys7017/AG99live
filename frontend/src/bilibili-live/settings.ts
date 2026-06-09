import {
  DEFAULT_BILIBILI_LIVE_SETTINGS,
  type BilibiliLiveSettings,
} from "../types/bilibili-live.js";

const STORAGE_KEY = "ag99live.bilibili_live.settings.v1";
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = DEFAULT_BILIBILI_LIVE_SETTINGS.responseIntervalSeconds;

export function normalizeBilibiliLiveSettings(value: unknown): BilibiliLiveSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_BILIBILI_LIVE_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    roomId: normalizeRoomId(record.roomId),
    cookie: normalizeCookie(record.cookie),
    responseIntervalSeconds: normalizeIntervalSeconds(record.responseIntervalSeconds),
  };
}

export function loadBilibiliLiveSettings(): BilibiliLiveSettings {
  if (typeof window === "undefined") {
    return { ...DEFAULT_BILIBILI_LIVE_SETTINGS };
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (!rawValue) {
      return { ...DEFAULT_BILIBILI_LIVE_SETTINGS };
    }
    return normalizeBilibiliLiveSettings(JSON.parse(rawValue));
  } catch (error) {
    console.warn("[BilibiliLive] Failed to load settings.", error);
    return { ...DEFAULT_BILIBILI_LIVE_SETTINGS };
  }
}

export function saveBilibiliLiveSettings(settings: BilibiliLiveSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeBilibiliLiveSettings(settings)),
    );
  } catch (error) {
    console.warn("[BilibiliLive] Failed to persist settings.", error);
  }
}

export function normalizeRoomId(value: unknown): string {
  const normalized = typeof value === "number"
    ? String(Math.trunc(value))
    : typeof value === "string"
      ? value.trim()
      : "";
  return /^\d+$/.test(normalized) ? normalized : "";
}

function normalizeCookie(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIntervalSeconds(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return Math.min(
    MAX_INTERVAL_SECONDS,
    Math.max(MIN_INTERVAL_SECONDS, Math.round(numeric)),
  );
}

