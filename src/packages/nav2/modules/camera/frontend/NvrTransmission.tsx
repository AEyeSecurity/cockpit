import { useEffect, useState } from "react";
import { api, ApiError, type Session } from "../../../../identity/api";

interface Transmission {
  enabled: boolean;
  online: number;
}

const path = "rover/nvr-transmission";

export function NvrTransmission(): JSX.Element | null {
  const [state, setState] = useState<Transmission>();
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (busy || !available) return;
    let current = true;
    async function refresh() {
      try {
        const next = await api<Transmission>(path);
        if (current) {
          setState(next);
          setError("");
        }
      } catch (failure) {
        if (current) {
          if (failure instanceof ApiError && failure.status === 404) setAvailable(false);
          setState(undefined);
          setError("No se pudo confirmar el estado de la transmisión.");
        }
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [busy, available]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const session = await api<Session>("session");
      setState(await api<Transmission>(path, "PUT", { enabled }, session.csrf));
    } catch {
      setState(undefined);
      setError("No se pudo confirmar el cambio. Consultando el estado…");
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;
  return <details className="cv-camera-action-section" open>
    <summary>Transmisión al NVR</summary>
    <div className="cv-camera-action-body">
      <p role="status">{busy ? "Aplicando cambio…" : error || (!state ? "Consultando estado…" :
        state.enabled ? `En vivo · ${state.online} de 3 cámaras con señal` : "En pausa · Rover detenido")}</p>
      <button type="button" className="cv-camera-action-button" disabled={busy || !state}
        onClick={() => state && void toggle(!state.enabled)}>
        {state?.enabled ? "Pausar transmisión" : "Activar transmisión"}
      </button>
    </div>
  </details>;
}
