// Offsets are fractions of each eye axis range, relative to its current pose.
export class SpeechGaze {
  public x = 0;
  public y = 0;
  private targetX = 0;
  private targetY = 0;
  private holdSeconds = 0;
  private voicedSeconds = 0;
  private quietSeconds = 0;
  private nextGlance = 2.2;

  public advance(delta: number, allowed: boolean, sourceActive: boolean, voiced: boolean): void {
    const dt = Math.max(0, Math.min(delta, 1));
    if (!allowed || !sourceActive) {
      this.holdSeconds = 0;
      this.voicedSeconds = 0;
      this.quietSeconds = 0;
      this.nextGlance = 2.2;
      this.targetX = this.targetY = 0;
    } else if (this.holdSeconds > 0) {
      this.holdSeconds -= dt;
      if (this.holdSeconds <= 0) this.targetX = this.targetY = 0;
    } else {
      if (voiced) this.voicedSeconds += dt;
      this.quietSeconds = voiced ? 0 : this.quietSeconds + dt;
      // Prefer a phrase break. Long uninterrupted speech also gets a brief glance.
      if (this.voicedSeconds >= this.nextGlance
        && (this.quietSeconds >= 0.12 || this.voicedSeconds >= this.nextGlance + 2)) {
        const direction = Math.random() < 0.5 ? -1 : 1;
        this.targetX = direction * (0.07 + Math.random() * 0.07);
        this.targetY = -0.02 - Math.random() * 0.04;
        this.holdSeconds = 0.4 + Math.random() * 0.35;
        this.voicedSeconds = 0;
        this.nextGlance = 3 + Math.random() * 2;
      }
    }
    const blend = allowed ? 1 - Math.exp(-dt * 15) : 1;
    this.x += (this.targetX - this.x) * blend;
    this.y += (this.targetY - this.y) * blend;
    if (Math.abs(this.x) < 0.0001) this.x = 0;
    if (Math.abs(this.y) < 0.0001) this.y = 0;
  }
}
