type InboundSocketData = string | ArrayBuffer | Blob;
const MAX_INBOUND_MESSAGES = 128;
const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

export interface AdapterConnectionTransportOptions {
  onOpen: (socket: WebSocket) => void;
  onMessage: (socket: WebSocket, rawData: InboundSocketData, signal: AbortSignal) => Promise<void> | void;
  onPriorityMessage: (socket: WebSocket, rawData: InboundSocketData) => boolean;
  onMessageError: (socket: WebSocket, error: unknown) => void;
  onError: (socket: WebSocket, opened: boolean) => void;
  onClose: (socket: WebSocket, opened: boolean) => void;
}

export interface AdapterConnectionTransport {
  socket: WebSocket;
  close: () => void;
}

export function openAdapterConnectionTransport(
  targetAddress: string,
  options: AdapterConnectionTransportOptions,
): AdapterConnectionTransport {
  const socket = new WebSocket(targetAddress);
  socket.binaryType = "arraybuffer";
  let opened = false;
  let stopped = false;
  let processing = false;
  let bufferedBytes = 0;
  let bufferedMessages = 0;
  let active: AbortController | null = null;
  const queue: { data: InboundSocketData; bytes: number }[] = [];

  function stop(): void {
    stopped = true;
    queue.length = 0;
    bufferedBytes = 0;
    bufferedMessages = 0;
    active?.abort();
  }

  function fail(error: unknown): void {
    if (stopped) return;
    stop();
    try {
      options.onMessageError(socket, error);
    } catch (observerError) {
      console.error("[AdapterTransport] inbound failure cleanup failed.", observerError);
    } finally {
      socket.close();
    }
  }

  async function drain(): Promise<void> {
    if (processing || stopped) return;
    processing = true;
    try {
      while (queue.length && !stopped) {
        const item = queue.shift()!;
        const controller = new AbortController();
        active = controller;
        try {
          await options.onMessage(socket, item.data, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) {
            fail(error);
            return;
          }
        } finally {
          active = null;
          if (!stopped) {
            bufferedBytes -= item.bytes;
            bufferedMessages -= 1;
          }
        }
      }
    } finally {
      processing = false;
    }
  }

  socket.addEventListener("open", () => {
    opened = true;
    options.onOpen(socket);
  });

  socket.addEventListener("message", (event) => {
    if (stopped) return;
    try {
      const data: unknown = event.data;
      let bytes: number;
      if (typeof data === "string") {
        if (data.length > MAX_INBOUND_BYTES) throw new Error("inbound_message_too_large");
        bytes = new TextEncoder().encode(data).byteLength;
      } else if (data instanceof ArrayBuffer) {
        bytes = data.byteLength;
      } else if (data instanceof Blob) {
        bytes = data.size;
      } else {
        throw new Error("inbound_message_type_invalid");
      }
      if (bytes > MAX_INBOUND_BYTES) throw new Error("inbound_message_too_large");
      if (options.onPriorityMessage(socket, data)) {
        // The priority handler settles the target timeline, waking a blocked
        // PCM append. Its in-flight continuation must not commit stale work.
        active?.abort();
        return;
      }
      if (bufferedMessages >= MAX_INBOUND_MESSAGES || bufferedBytes + bytes > MAX_INBOUND_BYTES) {
        throw new Error("inbound_message_queue_overflow");
      }
      queue.push({ data, bytes });
      bufferedBytes += bytes;
      bufferedMessages += 1;
      void drain().catch(fail);
    } catch (error) {
      fail(error);
    }
  });

  socket.addEventListener("error", () => {
    options.onError(socket, opened);
  });

  socket.addEventListener("close", () => {
    stop();
    options.onClose(socket, opened);
  });

  return {
    socket,
    close: () => {
      stop();
      socket.close();
    },
  };
}
