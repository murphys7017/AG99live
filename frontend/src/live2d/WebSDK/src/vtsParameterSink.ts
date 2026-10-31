const VTS_ENDPOINT_KEY = "ag99live.vts.endpoint";
const VTS_TOKEN_KEY = "ag99live.vts.token";
const VTS_ENABLED_KEY = "ag99live.vts.enabled";
const VTS_SEND_HZ_KEY = "ag99live.vts.send_hz";
const VTS_MAPPING_KEY = "ag99live.vts.parameter_mapping";
const VTS_DEFAULT_ENDPOINT = "ws://localhost:8001";
const VTS_DEFAULT_SEND_HZ = 3;

interface VtsParameterValue {
  id: string;
  value: number;
}

export class VtsParameterSink {
  private socket: WebSocket | null = null;
  private authenticated = false;
  private pendingValues: VtsParameterValue[] = [];
  private sendTimer: number | null = null;
  private requestCounter = 0;
  private lastSendAt = 0;

  public start(): void {
    if (!this.isEnabled() || this.socket) return;
    console.info("[VTS] parameter sink connecting.", { endpoint: this.endpoint() });
    this.socket = new WebSocket(this.endpoint());
    this.socket.addEventListener("open", () => {
      console.info("[VTS] websocket opened; requesting authentication.");
      void this.authenticate();
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(event));
    this.socket.addEventListener("close", () => this.resetConnection());
    this.socket.addEventListener("error", () => this.resetConnection());
    this.sendTimer = window.setInterval(() => this.flush(), 100);
  }

  public stop(): void {
    if (this.sendTimer !== null) {
      window.clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    this.authenticated = false;
    this.pendingValues = [];
    this.socket?.close();
    this.socket = null;
  }

  public publish(values: readonly VtsParameterValue[]): void {
    if (!this.isEnabled()) return;
    const mapping = this.readMapping();
    this.pendingValues = values
      .filter((entry) => entry.id.trim() && Number.isFinite(entry.value))
      .map((entry) => ({ id: mapping[entry.id.trim()] || entry.id.trim(), value: entry.value }));
    this.start();
  }

  private async authenticate(): Promise<void> {
    const token = this.readStorage(VTS_TOKEN_KEY);
    if (token) {
      this.send({
        messageType: "AuthenticationRequest",
        data: {
          pluginName: "AG99live",
          pluginDeveloper: "AG99live",
          authenticationToken: token,
        },
      });
      return;
    }
    this.send({
      messageType: "AuthenticationTokenRequest",
      data: {
        pluginName: "AG99live",
        pluginDeveloper: "AG99live",
      },
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: any;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.messageType === "AuthenticationTokenResponse") {
      const token = String(message.data?.authenticationToken || "").trim();
      if (token) {
        console.info("[VTS] received authentication token; authenticating plugin.");
        this.writeStorage(VTS_TOKEN_KEY, token);
        this.send({
          messageType: "AuthenticationRequest",
          data: {
            pluginName: "AG99live",
            pluginDeveloper: "AG99live",
            authenticationToken: token,
          },
        });
      }
      return;
    }
    if (message.messageType === "AuthenticationResponse") {
      this.authenticated = Boolean(message.data?.authenticated);
      console.info("[VTS] authentication response.", {
        authenticated: this.authenticated,
        reason: message.data?.reason ?? null,
      });
      return;
    }
    if (message.messageType === "APIErrorEvent") {
      console.warn("[VTS] API error.", message.data);
    }
  }

  private flush(): void {
    if (!this.authenticated || this.pendingValues.length === 0) return;
    const now = performance.now();
    const sendHz = this.sendHz();
    if (now - this.lastSendAt < 1000 / sendHz) return;
    this.lastSendAt = now;
    console.debug("[VTS] injecting parameter frame.", {
      parameterCount: this.pendingValues.length,
    });
    this.send({
      messageType: "InjectParameterDataRequest",
      data: {
        faceFound: true,
        mode: "set",
        parameterValues: this.pendingValues,
      },
    });
  }

  private send(message: { messageType: string; data: Record<string, unknown> }): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      requestID: `ag99live-${++this.requestCounter}`,
      ...message,
    }));
  }

  private resetConnection(): void {
    this.authenticated = false;
    this.socket = null;
    if (this.sendTimer !== null) {
      window.clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
  }

  private isEnabled(): boolean {
    return this.readStorage(VTS_ENABLED_KEY).toLowerCase() === "true";
  }

  private endpoint(): string {
    return this.readStorage(VTS_ENDPOINT_KEY) || VTS_DEFAULT_ENDPOINT;
  }

  private sendHz(): number {
    const value = Number(this.readStorage(VTS_SEND_HZ_KEY));
    return Number.isFinite(value) ? Math.max(1, Math.min(30, value)) : VTS_DEFAULT_SEND_HZ;
  }

  private readMapping(): Record<string, string> {
    try {
      const value = JSON.parse(this.readStorage(VTS_MAPPING_KEY) || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(([source, target]) =>
          source.trim() && typeof target === "string" && target.trim(),
        ).map(([source, target]) => [source.trim(), String(target).trim()]),
      );
    } catch {
      console.warn("[VTS] parameter mapping JSON is invalid; using direct IDs.");
      return {};
    }
  }

  private readStorage(key: string): string {
    try {
      return window.localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Optional bridge configuration must not affect local rendering.
    }
  }
}
