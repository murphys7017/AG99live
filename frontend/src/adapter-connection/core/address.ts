export const DEFAULT_ADAPTER_PORT = "12396";
export const DEFAULT_ADAPTER_ADDRESS = `127.0.0.1:${DEFAULT_ADAPTER_PORT}`;

export function normalizeWsAddress(raw: string): string {
  const trimmed = raw.trim();
  const candidate = trimmed || DEFAULT_ADAPTER_ADDRESS;
  const prefixed = /^[a-z]+:\/\//i.test(candidate) ? candidate : `ws://${candidate}`;
  const url = new URL(prefixed);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("连接地址必须是 ws://、wss://、http://、https:// 或主机名。");
  }

  if (!url.port) {
    url.port = DEFAULT_ADAPTER_PORT;
  }

  if (url.pathname === "/") {
    url.pathname = "";
  }

  return url.toString().replace(/\/$/, "");
}

export function buildConnectionCandidates(raw: string): string[] {
  return [normalizeWsAddress(raw)];
}

export function formatAddressHost(address: string): string {
  try {
    return new URL(address).host;
  } catch (_error) {
    return address;
  }
}

export function buildConnectFailureMessage(candidates: string[]): string {
  const label = candidates[0] ? formatAddressHost(candidates[0]) : "配置地址";
  return `未能连接适配器 ${label}，请检查地址和 AstrBot 插件状态。`;
}
