import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import {
  normalizeBackendHistoryMessages,
  normalizeBackendHistorySummaries,
} from "../adapter-connection/features/historyPayload.js";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
} from "../types/desktop.js";

interface HistoryApi {
  get: (path: string, params: Record<string, string>) => Promise<unknown>;
  post: (path: string, body: Record<string, string>) => Promise<unknown>;
}

export interface WebHistoryState {
  platformId: string;
  activeHistoryUid: string;
  viewedHistoryUid: string;
  histories: DesktopBackendHistorySummary[];
  messages: DesktopBackendHistoryMessage[];
}

export function normalizeWebHistoryState(value: unknown, platformId: string): WebHistoryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("history_response_invalid");
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.platform_id !== platformId
    || typeof payload.active_history_uid !== "string"
    || typeof payload.history_uid !== "string"
    || !Array.isArray(payload.histories)
    || !Array.isArray(payload.messages)
  ) {
    throw new Error("history_response_invalid");
  }
  return {
    platformId,
    activeHistoryUid: payload.active_history_uid.trim(),
    viewedHistoryUid: payload.history_uid.trim(),
    histories: normalizeBackendHistorySummaries(payload.histories),
    messages: normalizeBackendHistoryMessages(payload.messages),
  };
}

const HISTORY_ERRORS: Record<string, string> = {
  history_not_found: "该会话已不存在，或不属于当前适配器。请刷新会话列表。",
  history_uid_required: "请选择要操作的会话。",
  history_uid_invalid: "会话标识格式不正确，请刷新会话列表。",
  history_operation_failed: "无法确认会话操作结果，请先刷新列表核对，再决定是否重试。",
  history_delete_failed: "删除失败，会话可能仍然存在。请刷新确认。",
  history_response_invalid: "会话响应与当前适配器不一致，请刷新重试。",
  platform_not_found: "当前适配器已不可用，请刷新运行概况。",
  astrbot_dashboard_login_required: "请先登录 AstrBot。",
};

function historyErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  for (const [code, message] of Object.entries(HISTORY_ERRORS)) {
    if (detail.includes(code)) return message;
  }
  return detail || "无法读取对话历史。";
}

export function useWebHistory(platformId: Ref<string>, enabled: Readonly<Ref<boolean>>, api: HistoryApi) {
  const histories = shallowRef<DesktopBackendHistorySummary[]>([]);
  const messages = shallowRef<DesktopBackendHistoryMessage[]>([]);
  const activeHistoryUid = ref("");
  const viewedHistoryUid = ref("");
  const busy = ref(false);
  const error = ref("");
  const notice = ref("");
  let revision = 0;

  function reset(): void {
    revision += 1;
    histories.value = [];
    messages.value = [];
    activeHistoryUid.value = "";
    viewedHistoryUid.value = "";
    busy.value = false;
    error.value = "";
    notice.value = "";
  }

  async function request(
    action: "view" | "create" | "load" | "delete",
    historyUid = "",
  ): Promise<void> {
    const id = platformId.value;
    if (!id || busy.value) return;
    if ((action === "load" || action === "delete") && !historyUid.trim()) return;
    const currentRevision = ++revision;
    const isCurrent = () => currentRevision === revision && platformId.value === id;
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
      const params: Record<string, string> = { platform_id: id };
      if (historyUid) params.history_uid = historyUid;
      const response = action === "view"
        ? await api.get("control/history", params)
        : await api.post(`control/history/${action}`, params);
      if (!isCurrent()) return;
      const next = normalizeWebHistoryState(response, id);
      histories.value = next.histories;
      messages.value = next.messages;
      activeHistoryUid.value = next.activeHistoryUid;
      viewedHistoryUid.value = next.viewedHistoryUid;
      notice.value = ({
        view: "",
        create: "新会话已创建，并设为当前对话。",
        load: "当前对话已切换。",
        delete: "会话已删除。",
      })[action];
    } catch (cause) {
      if (isCurrent() && action === "view" && historyUid && historyErrorMessage(cause).includes("该会话已不存在")) {
        await request("view");
        return;
      }
      if (isCurrent()) error.value = historyErrorMessage(cause);
    } finally {
      if (isCurrent()) busy.value = false;
    }
  }

  // Invalidating synchronously also rejects an old A -> B -> A response.
  watch(platformId, () => {
    reset();
    if (enabled.value) void request("view");
  }, { flush: "sync" });
  watch(enabled, (visible) => {
    if (visible) void request("view", viewedHistoryUid.value);
  }, { immediate: true });
  onBeforeUnmount(() => { revision += 1; });

  return {
    histories,
    messages,
    activeHistoryUid,
    viewedHistoryUid,
    busy,
    error,
    notice,
    refresh: () => request("view", viewedHistoryUid.value),
    view: (uid: string) => request("view", uid),
    create: () => request("create"),
    load: (uid: string) => request("load", uid),
    delete: (uid: string) => request("delete", uid),
  };
}
