import { powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { isDesktopPresenceRequest } from "../../src/types/desktopPresence";
import { PresenceDetector } from "./presence-detector";

export function createDesktopPresenceMonitor() {
  const detector = new PresenceDetector(randomUUID());
  let locked = false;
  let suspended = false;
  const lock = () => { locked = true; detector.depart(performance.now()); };
  const unlock = () => { locked = false; };
  const suspend = () => { suspended = true; detector.depart(performance.now(), "resume"); };
  const resume = () => { suspended = false; };
  powerMonitor.on("lock-screen", lock);
  powerMonitor.on("unlock-screen", unlock);
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  return {
    read(request: unknown) {
      if (!isDesktopPresenceRequest(request)) throw new Error("desktop_presence_request_invalid");
      detector.configure(request.monitor_id, request.settings);
      const state = powerMonitor.getSystemIdleState(1);
      if (state === "unknown") return detector.sample(performance.now(), NaN, false);
      return detector.sample(performance.now(), powerMonitor.getSystemIdleTime(),
        locked || suspended || state === "locked");
    },
    stop() {
      powerMonitor.removeListener("lock-screen", lock);
      powerMonitor.removeListener("unlock-screen", unlock);
      powerMonitor.removeListener("suspend", suspend);
      powerMonitor.removeListener("resume", resume);
    },
  };
}
