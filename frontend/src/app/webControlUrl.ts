export const DEFAULT_ASTRBOT_WEBUI_URL = "http://127.0.0.1:6185/";
export const ASTRBOT_WEB_CONTROL_ROUTE =
  "/plugin-view/astrbot_plugin_ag99live_adapter/control-panel";

export function normalizeAstrbotWebUiUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("astrbot_webui_url_invalid");
  }
  const candidate = value.trim();
  if (
    !candidate
    || candidate.length > 255
    || !/^https?:\/\//i.test(candidate)
    || /[\u0000-\u001f\u007f\\?#]/.test(candidate)
  ) {
    throw new Error("astrbot_webui_url_invalid");
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("astrbot_webui_url_invalid");
  }
  const authority = candidate.slice(candidate.indexOf("://") + 3).split("/")[0];
  if (
    !url.hostname
    || url.username
    || url.password
    || authority.includes("@")
    || (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    throw new Error("astrbot_webui_url_invalid");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  if (url.href.length > 255) {
    throw new Error("astrbot_webui_url_invalid");
  }
  return url.href;
}

export function buildAstrbotWebControlUrl(
  value: unknown = DEFAULT_ASTRBOT_WEBUI_URL,
): string {
  const url = new URL(normalizeAstrbotWebUiUrl(value));
  url.hash = ASTRBOT_WEB_CONTROL_ROUTE;
  return url.href;
}
