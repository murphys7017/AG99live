import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
} from "../types/desktop";
import type {
  ProtocolEnvelope,
  SystemHistoryCreatedPayload,
  SystemHistoryDataPayload,
  SystemHistoryDeletedPayload,
  SystemHistoryListPayload,
} from "../types/protocol";
import {
  normalizeBackendHistoryMessages,
  normalizeBackendHistorySummaries,
} from "../adapter-connection/historyPayload";

export interface AdapterHistoryState {
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
}

export interface AdapterHistoryDependencies {
  getSocket: () => WebSocket | null;
  buildMessageEnvelope: <TPayload>(
    type: string,
    payload: TPayload,
    turnId?: string | null,
    orchestrationId?: string | null,
  ) => ProtocolEnvelope<TPayload>;
  pushHistory: (role: DesktopHistoryEntry["role"], text: string) => void;
  setLastError: (message: string) => void;
  setStatusMessage: (message: string) => void;
}

export function useAdapterHistory(
  state: AdapterHistoryState,
  deps: AdapterHistoryDependencies,
) {
  let pendingHistoryLoadUid: string | null = null;

  function validateSocket(): boolean {
    const socket = deps.getSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const error = "当前还没有连上适配器，无法操作对话历史。";
      deps.setLastError(error);
      deps.setStatusMessage(error);
      state.backendHistoryStatusMessage = error;
      deps.pushHistory("error", error);
      return false;
    }
    return true;
  }

  function applyHistoryList(
    envelope: ProtocolEnvelope<unknown>,
  ): void {
    const payload = envelope.payload as SystemHistoryListPayload;
    state.backendHistorySummaries = normalizeBackendHistorySummaries(
      payload.histories,
    );
    state.backendHistoryLoading = false;

    const hasActiveHistory = state.backendHistorySummaries.some(
      (summary) => summary.uid === state.activeBackendHistoryUid,
    );
    if (!hasActiveHistory && state.activeBackendHistoryUid) {
      state.activeBackendHistoryUid = "";
      state.backendHistoryEntries = [];
    }

    const message = state.backendHistorySummaries.length
      ? `已同步 ${state.backendHistorySummaries.length} 条后端会话索引。`
      : "后端当前没有可用的对话历史。";
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    deps.pushHistory("system", message);

    if (!state.activeBackendHistoryUid && state.backendHistorySummaries.length > 0) {
      loadHistory(state.backendHistorySummaries[0].uid, { announce: false });
    }
  }

  function applyHistoryCreated(
    envelope: ProtocolEnvelope<unknown>,
  ): void {
    const payload = envelope.payload as SystemHistoryCreatedPayload;
    const historyUid = payload.history_uid.trim();
    pendingHistoryLoadUid = null;
    state.backendHistoryLoading = false;
    state.activeBackendHistoryUid = historyUid;
    state.backendHistoryEntries = [];

    const message = historyUid
      ? `已创建新会话 ${historyUid}。`
      : "后端已创建新会话。";
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    deps.pushHistory("system", message);

    if (historyUid) {
      const placeholderSummary: DesktopBackendHistorySummary = {
        uid: historyUid,
        latestMessage: null,
        timestamp: new Date().toISOString(),
      };
      state.backendHistorySummaries = [
        placeholderSummary,
        ...state.backendHistorySummaries.filter((summary) => summary.uid !== historyUid),
      ];
    }
  }

  function applyHistoryData(
    envelope: ProtocolEnvelope<unknown>,
  ): void {
    const payload = envelope.payload as SystemHistoryDataPayload;
    state.backendHistoryEntries = normalizeBackendHistoryMessages(payload.messages);
    if (pendingHistoryLoadUid) {
      state.activeBackendHistoryUid = pendingHistoryLoadUid;
    }
    pendingHistoryLoadUid = null;
    state.backendHistoryLoading = false;

    const message = state.backendHistoryEntries.length
      ? `已载入 ${state.backendHistoryEntries.length} 条后端历史消息。`
      : "当前后端会话还没有历史消息。";
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    deps.pushHistory("system", message);
  }

  function applyHistoryDeleted(
    envelope: ProtocolEnvelope<unknown>,
  ): void {
    const payload = envelope.payload as SystemHistoryDeletedPayload;
    const historyUid = payload.history_uid.trim();
    state.backendHistoryLoading = false;

    if (!payload.success) {
      const error = historyUid
        ? `删除会话 ${historyUid} 失败。`
        : "删除会话失败。";
      deps.setLastError(error);
      deps.setStatusMessage(error);
      state.backendHistoryStatusMessage = error;
      deps.pushHistory("error", error);
      return;
    }

    state.backendHistorySummaries = state.backendHistorySummaries.filter(
      (summary) => summary.uid !== historyUid,
    );
    if (state.activeBackendHistoryUid === historyUid) {
      state.activeBackendHistoryUid = "";
      state.backendHistoryEntries = [];
    }

    const message = historyUid
      ? `已删除会话 ${historyUid}。`
      : "已删除当前会话。";
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    deps.pushHistory("system", message);
    requestHistoryList({ announce: false });
  }

  function requestHistoryList(
    options: { announce?: boolean } = {},
  ): boolean {
    if (!validateSocket()) {
      return false;
    }

    state.backendHistoryLoading = true;
    deps.getSocket()!.send(
      JSON.stringify(
        deps.buildMessageEnvelope("system.history_list_request", {}),
      ),
    );

    const message = "正在向后端请求对话历史列表。";
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    if (options.announce !== false) {
      deps.pushHistory("system", message);
    }
    return true;
  }

  function createHistory(
    options: { announce?: boolean } = {},
  ): boolean {
    if (!validateSocket()) {
      return false;
    }

    state.backendHistoryLoading = true;
    pendingHistoryLoadUid = null;
    deps.getSocket()!.send(
      JSON.stringify(
        deps.buildMessageEnvelope("system.history_create", {}),
      ),
    );

    const message = "正在请求新建后端会话。";
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    if (options.announce !== false) {
      deps.pushHistory("system", message);
    }
    return true;
  }

  function loadHistory(
    historyUid: string,
    options: { announce?: boolean } = {},
  ): boolean {
    const normalizedUid = historyUid.trim();
    if (!normalizedUid) {
      const error = "历史会话 UID 为空，无法载入。";
      deps.setLastError(error);
      deps.setStatusMessage(error);
      state.backendHistoryStatusMessage = error;
      deps.pushHistory("error", error);
      return false;
    }
    if (!validateSocket()) {
      return false;
    }

    state.backendHistoryLoading = true;
    pendingHistoryLoadUid = normalizedUid;
    deps.getSocket()!.send(
      JSON.stringify(
        deps.buildMessageEnvelope("system.history_load", {
          history_uid: normalizedUid,
        }),
      ),
    );

    const message = `正在载入会话 ${normalizedUid}。`;
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    if (options.announce !== false) {
      deps.pushHistory("system", message);
    }
    return true;
  }

  function deleteHistory(
    historyUid: string,
    options: { announce?: boolean } = {},
  ): boolean {
    const normalizedUid = historyUid.trim();
    if (!normalizedUid) {
      const error = "历史会话 UID 为空，无法删除。";
      deps.setLastError(error);
      deps.setStatusMessage(error);
      state.backendHistoryStatusMessage = error;
      deps.pushHistory("error", error);
      return false;
    }
    if (!validateSocket()) {
      return false;
    }

    state.backendHistoryLoading = true;
    deps.getSocket()!.send(
      JSON.stringify(
        deps.buildMessageEnvelope("system.history_delete", {
          history_uid: normalizedUid,
        }),
      ),
    );

    const message = `正在删除会话 ${normalizedUid}。`;
    state.backendHistoryStatusMessage = message;
    deps.setStatusMessage(message);
    if (options.announce !== false) {
      deps.pushHistory("system", message);
    }
    return true;
  }

  function resetHistoryState(): void {
    pendingHistoryLoadUid = null;
    state.backendHistoryLoading = false;
  }

  return {
    applyHistoryList,
    applyHistoryCreated,
    applyHistoryData,
    applyHistoryDeleted,
    requestHistoryList,
    createHistory,
    loadHistory,
    deleteHistory,
    resetHistoryState,
  };
}
