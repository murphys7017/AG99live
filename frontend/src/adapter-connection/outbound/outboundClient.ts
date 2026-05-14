import type { ProtocolEnvelope } from "../../types/protocol.js";

export interface AdapterOutboundClient {
  canSend: () => boolean;
  send: <TPayload>(
    type: string,
    payload: TPayload,
    turnId?: string | null,
    orchestrationId?: string | null,
  ) => boolean;
}

export interface AdapterOutboundClientDeps {
  getSocket: () => WebSocket | null;
  buildEnvelope: <TPayload>(
    type: string,
    payload: TPayload,
    turnId?: string | null,
    orchestrationId?: string | null,
  ) => ProtocolEnvelope<TPayload>;
}

export function createAdapterOutboundClient(
  deps: AdapterOutboundClientDeps,
): AdapterOutboundClient {
  function canSend(): boolean {
    const socket = deps.getSocket();
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
  }

  function send<TPayload>(
    type: string,
    payload: TPayload,
    turnId?: string | null,
    orchestrationId?: string | null,
  ): boolean {
    const socket = deps.getSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(
        JSON.stringify(
          deps.buildEnvelope(type, payload, turnId, orchestrationId),
        ),
      );
      return true;
    } catch (error) {
      console.warn("[Connection] failed to send outbound protocol message.", type, error);
      return false;
    }
  }

  return {
    canSend,
    send,
  };
}
