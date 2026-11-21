import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { app } from "electron";

import { parseDesktopLatencyEvent } from "../shared/desktop-latency-event";

interface PendingLine {
  day: string;
  line: string;
  resolve: (written: boolean) => void;
  reject: (error: unknown) => void;
}

const pending: PendingLine[] = [];
let writer: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function flushDesktopLatencyLog(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  if (writer) return writer;
  if (!pending.length) return Promise.resolve();
  const directory = join(app.getPath("logs"), "ag99live");
  writer = (async () => {
    while (pending.length) {
      const batch = pending.splice(0, 128);
      try {
        await mkdir(directory, { recursive: true });
        const files = new Map<string, string[]>();
        for (const entry of batch) {
          const lines = files.get(entry.day) ?? [];
          lines.push(entry.line);
          files.set(entry.day, lines);
        }
        for (const [day, lines] of files) {
          await appendFile(join(directory, `olv-latency-${day}.jsonl`), lines.join(""), "utf8");
        }
        for (const entry of batch) entry.resolve(true);
      } catch (error) {
        for (const entry of batch) entry.reject(error);
      }
    }
    writer = null;
  })();
  return writer;
}

export function appendDesktopLatencyEvent(value: unknown): Promise<boolean> {
  const event = parseDesktopLatencyEvent(value);
  if (!event) return Promise.resolve(false);
  if (pending.length >= 4096) return Promise.reject(new Error("desktop_latency_log_capacity_exceeded"));
  const now = new Date();
  const line = JSON.stringify({ ...event, recordedAtEpochMs: now.getTime() }) + "\n";
  return new Promise((resolve, reject) => {
    pending.push({ day: now.toISOString().slice(0, 10), line, resolve, reject });
    if (pending.length >= 128) void flushDesktopLatencyLog();
    else if (!writer && timer === undefined) timer = setTimeout(flushDesktopLatencyLog, 100);
  });
}
