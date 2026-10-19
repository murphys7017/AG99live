import type { DesktopPresenceSettings, DesktopPresenceSnapshot } from "../../src/types/desktopPresence";

interface Absence {
  basis: "unlock" | "resume" | "input_resumed";
  since: number;
  eligible: boolean;
}

/** Uses input timing only: input inactivity is never proof of physical absence. */
export class PresenceDetector {
  private identity = "";
  private settings: DesktopPresenceSettings | null = null;
  private initialized = false;
  private armed = false;
  private previousInputAt = -Infinity;
  private away: Absence | null = null;
  private candidate: { since: number; inputAt: number; inactiveSeconds: number } | null = null;
  private sequence = 0;
  private returned: { value: NonNullable<DesktopPresenceSnapshot["returned"]>; at: number } | null = null;

  constructor(private readonly bootId: string) {}

  configure(identity: string, settings: DesktopPresenceSettings): void {
    const next = JSON.stringify([identity, settings]);
    if (next === this.identity) return;
    this.identity = next;
    this.settings = { ...settings };
    this.initialized = this.armed = false;
    this.previousInputAt = -Infinity;
    this.away = this.candidate = this.returned = null;
    // Keep sequence monotonic across connection/configuration changes.
  }

  depart(now: number, basis: "unlock" | "resume" = "unlock"): void {
    if (!this.settings || !this.initialized) return;
    if (!this.away || this.away.basis === "input_resumed") {
      this.away = { basis, since: now, eligible: true };
    }
    this.candidate = null;
  }

  sample(now: number, idleSeconds: number, blocked: boolean): DesktopPresenceSnapshot {
    if (!this.settings || !Number.isFinite(idleSeconds) || idleSeconds < 0) {
      this.initialized = this.armed = false;
      this.away = this.candidate = null;
      return this.snapshot(now, "unknown");
    }
    const inputAt = now - idleSeconds * 1000;
    if (!this.initialized) {
      this.initialized = true;
      this.previousInputAt = inputAt;
      this.armed = !blocked && idleSeconds <= 2;
      if (blocked || idleSeconds >= this.settings.idle_after_seconds) {
        this.away = { basis: blocked ? "unlock" : "input_resumed", since: now, eligible: false };
      }
      return this.snapshot(now, blocked || this.away ? "inactive" : "active");
    }
    if (blocked) {
      this.depart(now);
      return this.snapshot(now, "inactive");
    }
    if (!this.away && idleSeconds >= this.settings.idle_after_seconds) {
      this.away = { basis: "input_resumed", since: inputAt, eligible: this.armed };
    }
    if (this.away) {
      if (!this.candidate && idleSeconds <= 2) {
        const duration = Math.max(0, (now - this.away.since) / 1000);
        const minimum = this.away.basis === "input_resumed"
          ? this.settings.idle_after_seconds : this.settings.minimum_away_seconds;
        if (!this.away.eligible || duration < minimum) {
          this.away = null;
          this.armed = true;
        } else {
          this.candidate = { since: now, inputAt, inactiveSeconds: Math.floor(duration) };
        }
      }
      if (this.candidate && this.away) {
        if (now - this.candidate.since > 15_000) {
          this.away = this.candidate = null;
          this.armed = true;
        } else if (now - this.candidate.since >= this.settings.confirmation_seconds * 1000
          && inputAt - this.candidate.inputAt >= 1500 && idleSeconds <= 2) {
          this.sequence += 1;
          this.returned = { at: now, value: {
            event_id: `${this.bootId}:${this.sequence}`, basis: this.away.basis,
            inactive_seconds: this.candidate.inactiveSeconds, age_seconds: 0,
          } };
          this.away = this.candidate = null;
          this.armed = true;
        }
      }
    } else if (inputAt - this.previousInputAt >= 1500) {
      this.armed = true;
    }
    // Idle seconds are integral. A >1.5s advance after confirmation proves a
    // further input; one mouse bump followed by increasing idle time cannot pass.
    this.previousInputAt = Math.max(this.previousInputAt, inputAt);
    return this.snapshot(now, this.candidate ? "confirming" : this.away ? "inactive" : "active");
  }

  private snapshot(now: number, state: DesktopPresenceSnapshot["state"]): DesktopPresenceSnapshot {
    return {
      boot_id: this.bootId, sequence: this.sequence, state,
      returned: this.returned ? { ...this.returned.value,
        age_seconds: Math.max(0, (now - this.returned.at) / 1000) } : null,
    };
  }
}
