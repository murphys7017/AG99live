import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
} from "../types/desktop";

export function normalizeBackendHistorySummaries(
  histories: unknown,
): DesktopBackendHistorySummary[] {
  if (!Array.isArray(histories)) {
    return [];
  }

  const normalized: DesktopBackendHistorySummary[] = [];
  for (const history of histories) {
    if (!history || typeof history !== "object") {
      continue;
    }

    const candidate = history as Record<string, unknown>;
    const uid = typeof candidate.uid === "string" ? candidate.uid.trim() : "";
    if (!uid) {
      continue;
    }

    const latestMessage = normalizeBackendHistorySummaryMessage(candidate.latest_message);
    const timestamp = typeof candidate.timestamp === "string"
      ? candidate.timestamp.trim()
      : latestMessage?.timestamp ?? "";

    normalized.push({
      uid,
      latestMessage,
      timestamp,
    });
  }

  return normalized;
}

function normalizeBackendHistorySummaryMessage(
  message: unknown,
): DesktopBackendHistorySummary["latestMessage"] {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = message as Record<string, unknown>;
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  const timestamp = typeof candidate.timestamp === "string" ? candidate.timestamp.trim() : "";
  const role = normalizeBackendHistoryRole(candidate.role);
  if (!content && !timestamp) {
    return null;
  }

  return {
    role,
    timestamp,
    content,
  };
}

export function normalizeBackendHistoryMessages(
  messages: unknown,
): DesktopBackendHistoryMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const normalized: DesktopBackendHistoryMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const candidate = message as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id) {
      continue;
    }

    normalized.push({
      id,
      role: normalizeBackendHistoryRole(candidate.role),
      type: typeof candidate.type === "string" && candidate.type.trim()
        ? candidate.type.trim()
        : "text",
      content: typeof candidate.content === "string" ? candidate.content.trim() : "",
      timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp.trim() : "",
      name: typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : undefined,
      toolId: typeof candidate.tool_id === "string" && candidate.tool_id.trim()
        ? candidate.tool_id.trim()
        : undefined,
      toolName: typeof candidate.tool_name === "string" && candidate.tool_name.trim()
        ? candidate.tool_name.trim()
        : undefined,
      status: typeof candidate.status === "string" && candidate.status.trim()
        ? candidate.status.trim()
        : undefined,
      avatar: typeof candidate.avatar === "string" && candidate.avatar.trim()
        ? candidate.avatar.trim()
        : undefined,
    });
  }

  return normalized;
}

function normalizeBackendHistoryRole(
  role: unknown,
): DesktopBackendHistoryMessage["role"] {
  if (typeof role !== "string") {
    return "system";
  }
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "human" || normalizedRole === "ai") {
    return normalizedRole;
  }
  return "system";
}
