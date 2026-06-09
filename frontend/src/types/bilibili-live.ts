export interface BilibiliLiveSettings {
  enabled: boolean;
  roomId: string;
  cookie: string;
  responseIntervalSeconds: number;
}

export interface BilibiliLiveStatus {
  enabled: boolean;
  connected: boolean;
  status: "disabled" | "idle" | "connecting" | "connected" | "waiting" | "error";
  roomId: string;
  realRoomId: number | null;
  bufferedCount: number;
  lastMessageAt: string;
  lastError: string;
  hasCookie: boolean;
}

export interface BilibiliDanmakuMessage {
  uid: number;
  uname: string;
  text: string;
  timestamp: number;
}

export interface BilibiliDanmakuHost {
  host: string;
  wssPort: number;
}

export interface BilibiliDanmakuInfo {
  realRoomId: number;
  uid: number;
  buvid: string;
  token: string;
  hosts: BilibiliDanmakuHost[];
}

export type BilibiliDanmakuInfoResult =
  | { ok: true; info: BilibiliDanmakuInfo }
  | { ok: false; error: string };

export const DEFAULT_BILIBILI_LIVE_SETTINGS: BilibiliLiveSettings = {
  enabled: false,
  roomId: "",
  cookie: "",
  responseIntervalSeconds: 30,
};

export const DEFAULT_BILIBILI_LIVE_STATUS: BilibiliLiveStatus = {
  enabled: false,
  connected: false,
  status: "disabled",
  roomId: "",
  realRoomId: null,
  bufferedCount: 0,
  lastMessageAt: "",
  lastError: "",
  hasCookie: false,
};
