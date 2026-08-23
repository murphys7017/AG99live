import type { DesktopWindowRole } from "../types/desktop";

export function getWindowRole(): DesktopWindowRole {
  if (typeof window === "undefined") {
    return "pet";
  }

  const params = new URLSearchParams(window.location.search);
  const value = params.get("window");
  if (value === null) {
    console.warn("[WindowRole] missing window query parameter; defaulting to pet.");
    return "pet";
  }
  if (
    value === "pet" ||
    value === "overlay" ||
    value === "settings" ||
    value === "history" ||
    value === "action_lab" ||
    value === "profile_editor"
  ) {
    return value;
  }

  console.error(`[WindowRole] unsupported window role '${value}'; defaulting to pet.`);
  return "pet";
}
