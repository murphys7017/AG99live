import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { app } from "electron";

import { parseDesktopLatencyEvent } from "../shared/desktop-latency-event";

import type { DesktopLatencyEvent } from "../../src/types/desktop";

export async function appendDesktopLatencyEvent(value: unknown): Promise<boolean> {
  const event = parseDesktopLatencyEvent(value);
  if (!event) {
    return false;
  }

  const directory = join(app.getPath("logs"), "ag99live");
  const date = new Date().toISOString().slice(0, 10);
  const path = join(directory, `olv-latency-${date}.jsonl`);
  await mkdir(directory, { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({ ...event, recordedAtEpochMs: Date.now() })}\n`,
    "utf8",
  );
  return true;
}
