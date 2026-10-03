/**
 * Shapes served by the plugin's `control/desktop/settings` endpoints.
 *
 * These settings are physically owned by the machine running the desktop app.
 * The adapter only brokers one list/set exchange at a time, so the page shows
 * the desktop's last reported value and marks itself read-only while the
 * desktop is offline rather than pretending the value is current.
 */

export type DesktopSettingsAction = "list" | "set";

export type DesktopSettingOption = {
  id: string;
  label: string;
};

export type DesktopSettingKind = "toggle" | "text" | "number" | "range" | "select";

export type DesktopSettingEntry = {
  key: string;
  order: number;
  label: string;
  description: string;
  kind: DesktopSettingKind;
  value: string;
  options: DesktopSettingOption[];
  minimum?: number;
  maximum?: number;
  step?: number;
  reportedAt: string;
};

export type DesktopSettingsState = {
  connected: boolean;
  connectionRevision: number;
  platformId: string;
  settings: Record<string, DesktopSettingEntry>;
};

export type DesktopSettingsQueryResponse = {
  ok: boolean;
  key?: string;
  entry?: {
    value: string;
    options: DesktopSettingOption[];
    minimum?: number;
    maximum?: number;
    step?: number;
    reportedAt: string;
  };
  error?: { code: string; key?: string };
  connected: boolean;
  connectionRevision: number;
  settings: Record<string, DesktopSettingEntry>;
};

export const DESKTOP_ERROR_FALLBACKS: Record<string, string> = {
  desktop_client_offline: "桌面端当前未连接，暂时无法修改它的本机配置。",
  desktop_client_timeout: "桌面端没有在预期时间内响应，请确认它还在运行。",
  desktop_client_send_failed: "向桌面端发送请求失败。",
  desktop_setting_unsupported: "该配置项尚未接入桌面端。",
  desktop_setting_action_invalid: "不支持的请求动作。",
  desktop_setting_value_required: "请选择一个取值。",
  desktop_setting_value_invalid: "取值格式不正确。",
  desktop_setting_value_out_of_range: "取值超出允许范围。",
  desktop_setting_value_not_available: "桌面端当前没有这个选项或设备，可能已变化。",
  desktop_setting_failed: "桌面端处理该配置时出错。",
  platform_not_found: "没有找到对应的 Adapter 实例。",
};

export function desktopErrorMessage(code: string | undefined): string {
  if (!code) return "桌面端配置请求失败。";
  return DESKTOP_ERROR_FALLBACKS[code] ?? `桌面端配置请求失败（${code}）。`;
}

export function formatReportedAt(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString();
}
