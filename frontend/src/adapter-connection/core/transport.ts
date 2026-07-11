export interface AdapterConnectionTransportOptions {
  onOpen: (socket: WebSocket) => void;
  onMessage: (socket: WebSocket, rawData: string | ArrayBuffer | Blob) => void;
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
  let opened = false;

  socket.addEventListener("open", () => {
    opened = true;
    options.onOpen(socket);
  });

  socket.addEventListener("message", (event) => {
    options.onMessage(socket, event.data as string | ArrayBuffer | Blob);
  });

  socket.addEventListener("error", () => {
    options.onError(socket, opened);
  });

  socket.addEventListener("close", () => {
    options.onClose(socket, opened);
  });

  return {
    socket,
    close: () => {
      socket.close();
    },
  };
}
