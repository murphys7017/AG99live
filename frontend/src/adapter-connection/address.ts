export const DEFAULT_ADAPTER_ADDRESS = "127.0.0.1:12396";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

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
    url.port = "12396";
  }

  if (url.pathname === "/") {
    url.pathname = "";
  }

  return url.toString().replace(/\/$/, "");
}

export function getLocalAdapterHosts(): string[] {
  const fallbackHosts = ["127.0.0.1", "localhost"];
  if (typeof window === "undefined") {
    return fallbackHosts;
  }
  const hosts = window.ag99desktop?.getLocalAdapterHosts?.() ?? fallbackHosts;
  const normalizedHosts: string[] = [];
  const seen = new Set<string>();

  for (const host of hosts) {
    const value = host.trim();
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedHosts.push(value);
  }

  return normalizedHosts.length ? normalizedHosts : fallbackHosts;
}

export function buildConnectionCandidates(raw: string): string[] {
  const primaryAddress = normalizeWsAddress(raw);
  const primaryUrl = new URL(primaryAddress);
  const candidates = [primaryAddress];

  if (!LOOPBACK_HOSTS.has(primaryUrl.hostname.toLowerCase())) {
    return candidates;
  }

  const seen = new Set(candidates);
  for (const host of getLocalAdapterHosts()) {
    const candidateUrl = new URL(primaryAddress);
    candidateUrl.hostname = host;
    const candidateAddress = candidateUrl.toString().replace(/\/$/, "");
    if (seen.has(candidateAddress)) {
      continue;
    }

    seen.add(candidateAddress);
    candidates.push(candidateAddress);
  }

  return candidates;
}

export function formatAddressHost(address: string): string {
  try {
    return new URL(address).host;
  } catch (_error) {
    return address;
  }
}

export function buildConnectFailureMessage(candidates: string[]): string {
  const labels = candidates.map((candidate) => formatAddressHost(candidate));
  return labels.length > 1
    ? `未能连接适配器，已尝试 ${labels.join(" / ")}。`
    : "WebSocket 连接异常，请检查地址和 AstrBot 插件状态。";
}
