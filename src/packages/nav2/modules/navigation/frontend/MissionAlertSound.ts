import type { NavigationService } from "../service/impl/NavigationService";

/** One short chime per operator block, independent of which panels are visible. */
export class MissionAlertSound {
  private context?: AudioContext;
  private blocked = false;
  private disposed = false;
  private unsubscribe: () => void;

  constructor(service: NavigationService) {
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
    this.unsubscribe = service.subscribe((state) => {
      const blocked = state.routeMission.blockedState === "NEEDS_OPERATOR";
      if (blocked && !this.blocked) this.play();
      this.blocked = blocked;
    });
  }

  // Browsers require a user gesture before allowing audio.
  private unlock = (): void => {
    if (this.disposed || typeof window.AudioContext !== "function") return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state === "suspended") {
        void this.context.resume().catch(() => {});
      }
    } catch {
      // The visual alert remains available if audio is unsupported.
    }
  };

  private play(): void {
    const context = this.context;
    if (!context || context.state !== "running") return;
    try {
      const start = context.currentTime;
      [660, 880, 660].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const at = start + index * 0.22;
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.16, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.17);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(at);
        oscillator.stop(at + 0.18);
      });
    } catch {
      // Audio failure must never interrupt navigation state updates.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
    if (this.context) void this.context.close().catch(() => {});
  }
}
