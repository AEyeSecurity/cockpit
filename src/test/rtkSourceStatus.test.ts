import { describe, expect, it } from "vitest";
import { rtkSourceStatus } from "../packages/nav2/modules/navigation/rtkSourceStatus";

const state = {
  active_source_id: "ign_ucor", connected: true, receiving_rtcm: true,
  rtcm_age_s: 0.5, rtcm_stale_timeout_s: 10
};

describe("RTK source status", () => {
  it("does not equate a successful handshake with corrections", () => {
    expect(rtkSourceStatus({ ...state, receiving_rtcm: false }).receiving).toBe(false);
    expect(rtkSourceStatus({ ...state, receiving_rtcm: false }).text).toContain("esperando RTCM válido");
  });
  it("requires an identified source and explicit fresh validated RTCM", () => {
    expect(rtkSourceStatus(state).receiving).toBe(true);
    for (const change of [
      { active_source_id: "" }, { connected: false }, { receiving_rtcm: undefined },
      { rtcm_age_s: null }, { rtcm_age_s: NaN }, { rtcm_age_s: 11 }, { rtcm_age_s: -1 }
    ]) {
      expect(rtkSourceStatus({ ...state, ...change }).receiving).toBe(false);
    }
  });
  it("does not report a cached or disconnected stream as live", () => {
    expect(rtkSourceStatus(state, false)).toEqual({ receiving: false, text: "Sin telemetría RTK reciente" });
    expect(rtkSourceStatus(null)).toEqual({ receiving: false, text: "Sin fuente activa" });
  });
});
