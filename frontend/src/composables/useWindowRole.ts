import type { DesktopWindowRole } from "../types/desktop";

export function getWindowRole(): DesktopWindowRole {
  if (typeof window === "undefined") {
    return "pet";
  }

  const params = new URLSearchParams(window.location.search);
  const value = params.get("window");
  if (
    value === "pet" ||
    value === "overlay" ||
    value === "settings" ||
    value === "history"
  ) {
    return value;
  }

  return "pet";
}
