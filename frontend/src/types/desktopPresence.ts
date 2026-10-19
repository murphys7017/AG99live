export const DESKTOP_PRESENCE_SCHEMA = "ag99live.desktop_presence.v1" as const;

export interface DesktopPresenceSettings {
  idle_after_seconds: number;
  minimum_away_seconds: number;
  confirmation_seconds: number;
}

export interface DesktopPresenceRequest {
  schema_version: typeof DESKTOP_PRESENCE_SCHEMA;
  request_id: string;
  monitor_id: string;
  settings: DesktopPresenceSettings;
}

export interface DesktopPresenceSnapshot {
  boot_id: string;
  sequence: number;
  state: "active" | "inactive" | "confirming" | "unknown";
  returned: {
    event_id: string;
    basis: "unlock" | "resume" | "input_resumed";
    inactive_seconds: number;
    age_seconds: number;
  } | null;
}

export function isDesktopPresenceRequest(value: unknown): value is DesktopPresenceRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<DesktopPresenceRequest>;
  const settings = request.settings;
  return request.schema_version === DESKTOP_PRESENCE_SCHEMA
    && typeof request.request_id === "string" && request.request_id.length > 0 && request.request_id.length <= 128
    && typeof request.monitor_id === "string" && request.monitor_id.length > 0 && request.monitor_id.length <= 128
    && !!settings && typeof settings === "object"
    && Number.isInteger(settings.idle_after_seconds) && settings.idle_after_seconds >= 30 && settings.idle_after_seconds <= 3600
    && Number.isInteger(settings.minimum_away_seconds) && settings.minimum_away_seconds >= 10 && settings.minimum_away_seconds <= 3600
    && Number.isInteger(settings.confirmation_seconds) && settings.confirmation_seconds >= 3 && settings.confirmation_seconds <= 10;
}
