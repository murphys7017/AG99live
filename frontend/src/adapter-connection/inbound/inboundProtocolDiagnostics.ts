import type { ProtocolEnvelope } from "../../types/protocol.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";

export interface InboundProtocolDiagnosticState {
  statusMessage: string;
  lastError: string;
}

export interface InboundProtocolDiagnosticDeps {
  state: InboundProtocolDiagnosticState;
  pushHistory: (role: string, text: string) => void;
  reportedProtocolWarnings: Set<string>;
}

export function reportInboundProtocolError(
  deps: InboundProtocolDiagnosticDeps,
  event: Extract<InboundAdapterEvent, { kind: "protocol_error" }>,
): void {
  reportProtocolError(
    deps,
    event.warningKey,
    event.error.message,
    event.envelope,
  );
}

export function reportUnhandledInboundEnvelope(
  deps: InboundProtocolDiagnosticDeps,
  envelope: ProtocolEnvelope<unknown>,
): void {
  const key = `type:${envelope.type}`;
  const message = `收到未接入的协议消息 ${envelope.type}。`;
  deps.state.lastError = "";
  deps.state.statusMessage = message;
  if (!deps.reportedProtocolWarnings.has(key)) {
    deps.pushHistory("system", message);
    deps.reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] unhandled inbound protocol message.", envelope.type, envelope);
}

function reportProtocolError(
  deps: InboundProtocolDiagnosticDeps,
  key: string,
  message: string,
  envelope?: ProtocolEnvelope<unknown>,
): void {
  const s = deps.state;
  s.lastError = message;
  s.statusMessage = message;
  if (!deps.reportedProtocolWarnings.has(key)) {
    deps.pushHistory("error", message);
    deps.reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] protocol error.", message, envelope);
}
