import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionAlertSound } from "../packages/nav2/modules/navigation/frontend/MissionAlertSound";
import type { NavigationService, NavigationState } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

afterEach(() => vi.unstubAllGlobals());

describe("mission alert sound", () => {
  it("sounds once per terminal block, rearms after recovery, and cleans up", () => {
    const start = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn();
    vi.stubGlobal("AudioContext", class {
      state = "running";
      currentTime = 0;
      destination = {};
      close = close;
      createOscillator() {
        return { frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start, stop: vi.fn() };
      }
      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(), disconnect: vi.fn()
        };
      }
    });
    let receive!: (state: NavigationState) => void;
    const service = { subscribe: (callback: typeof receive) => { receive = callback; return unsubscribe; } };
    const sound = new MissionAlertSound(service as unknown as NavigationService);
    window.dispatchEvent(new Event("pointerdown"));
    const emit = (blockedState: string) => receive({ routeMission: { blockedState } } as NavigationState);
    emit("WAITING_RETRY");
    expect(start).not.toHaveBeenCalled();
    emit("NEEDS_OPERATOR");
    emit("NEEDS_OPERATOR");
    expect(start).toHaveBeenCalledTimes(3);
    emit("CLEAR");
    emit("NEEDS_OPERATOR");
    expect(start).toHaveBeenCalledTimes(6);
    sound.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps state updates safe when audio is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    let receive!: (state: NavigationState) => void;
    const sound = new MissionAlertSound({
      subscribe: (callback: typeof receive) => { receive = callback; return () => {}; }
    } as unknown as NavigationService);
    window.dispatchEvent(new Event("pointerdown"));
    expect(() => receive({ routeMission: { blockedState: "NEEDS_OPERATOR" } } as NavigationState)).not.toThrow();
    sound.dispose();
  });
});
