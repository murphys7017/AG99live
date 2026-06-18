import type { ProtocolEnvelope, SystemServerInfoPayload } from "../../types/protocol.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";

export interface InboundConnectionDispatchState {
  statusMessage: string;
  micRequested: boolean;
  pttModeEnabled: boolean;
  serverInfo: SystemServerInfoPayload | null;
}

export interface InboundConnectionDispatchDeps {
  state: InboundConnectionDispatchState;
  pushHistory: (role: string, text: string) => void;
  rewriteSocketUrl: (rawUrl: string) => string;
  rewriteHttpUrl: (rawUrl: string | null) => string;
  startMicrophoneCapture: (origin?: "manual" | "ptt" | "auto") => Promise<boolean>;
}

type InboundConnectionEvent = Extract<
  InboundAdapterEvent,
  { kind: "server_info" }
>;

export function dispatchInboundConnectionEvent(
  deps: InboundConnectionDispatchDeps,
  event: InboundConnectionEvent,
): void {
  applyServerInfoMessage(deps, event.envelope);
}

function applyServerInfoMessage(
  deps: InboundConnectionDispatchDeps,
  envelope: ProtocolEnvelope<SystemServerInfoPayload>,
): void {
  const s = deps.state;
  s.serverInfo = {
    ...envelope.payload,
    ws_url: deps.rewriteSocketUrl(envelope.payload.ws_url),
    http_base_url: deps.rewriteHttpUrl(envelope.payload.http_base_url),
  };
  s.statusMessage = "适配器已连接，等待模型同步。";
  deps.pushHistory("system", "收到后端运行信息。");
  if (s.serverInfo.auto_start_mic) {
    if (s.pttModeEnabled) {
      deps.pushHistory("system", "后端请求自动收音，当前为按键说话模式，已跳过。");
    } else {
      s.micRequested = true;
      void deps.startMicrophoneCapture("auto");
    }
  }
}
