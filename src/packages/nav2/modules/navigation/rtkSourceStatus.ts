export function rtkSourceStatus(state: Record<string, unknown> | null, telemetryFresh = true): {
  receiving: boolean;
  text: string;
} {
  const active = String(state?.active_source_id ?? "").trim();
  const age = state?.rtcm_age_s;
  const limit = state?.rtcm_stale_timeout_s;
  const receiving = telemetryFresh && Boolean(active) && state?.connected === true &&
    state?.receiving_rtcm === true && typeof age === "number" && Number.isFinite(age) && age >= 0 &&
    typeof limit === "number" && Number.isFinite(limit) && limit > 0 && age <= limit;
  return {
    receiving,
    text: !telemetryFresh ? "Sin telemetría RTK reciente" : receiving ? "Recibiendo correcciones RTCM" :
      state?.connected === true ? "NTRIP conectado · esperando RTCM válido" :
        active ? "Base seleccionada · reconectando" : "Sin fuente activa"
  };
}
