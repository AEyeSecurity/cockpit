import { useEffect, useState } from "react";
import type { ModuleContext } from "../../../../../core/types/module";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import type { NavigationService } from "../../navigation/service/impl/NavigationService";
import { batteryChargeWarning } from "../../../shared/batteryCharge";
import type { TelemetryService } from "../service/impl/TelemetryService";
import "./batteryAlert.css";

const UNRELIABLE_STATES = new Set(["UNAVAILABLE", "STALE", "LINK_STALE", "SUSPECT"]);

export function BatteryAlert({ runtime }: { runtime: ModuleContext }): JSX.Element | null {
  const [alert, setAlert] = useState<{ tone: "warn" | "critical"; percentage: number } | null>(null);

  const [manualControl, setManualControl] = useState(true);

  useEffect(() => {
    if (!runtime.services.has("nav2.service.telemetry") || !runtime.services.has("nav2.service.connection")) return;
    const telemetry = runtime.getService<TelemetryService>("nav2.service.telemetry");
    const connection = runtime.getService<ConnectionService>("nav2.service.connection");

    let shown: ReturnType<typeof batteryChargeWarning> = null;
    let connected = false;
    const stopConnection = connection.subscribe((state) => { connected = state.connected; });
    const stopNavigation = runtime.services.has("nav2.service.navigation")
      ? runtime.getService<NavigationService>("nav2.service.navigation").subscribe((state) => {
        setManualControl(state.manualMode || state.manualDisablePending);
      })
      : () => {};
    const stopTelemetry = telemetry.subscribeTelemetry(({ robotStatus }) => {
      const { batteryPct, batteryPresent, batteryState } = robotStatus;
      if (!connected || !robotStatus.connected || batteryPresent === false ||
          UNRELIABLE_STATES.has(batteryState.trim().toUpperCase())) return;
      if (batteryPct === null || !Number.isFinite(batteryPct) || batteryPct < 0 || batteryPct > 100) return;

      const tone = batteryChargeWarning(batteryPct);
      if (tone === null) {
        shown = null;
      } else if (shown === null || (shown === "warn" && tone === "critical")) {
        shown = tone;
        setAlert({ tone, percentage: batteryPct });
      }
    });

    return () => {
      stopNavigation();
      stopTelemetry();
      stopConnection();
    };
  }, [runtime]);

  if (!alert) return null;
  const critical = alert.tone === "critical";
  return (
    <aside className={`nav-rover-access-dialog nav-battery-alert tone-${alert.tone}`}>
      <div role="alert">
        <strong>{critical ? "Batería crítica" : "Batería baja"}</strong>
        <p>El Rover registró {alert.percentage.toFixed(1)} % de carga.</p>
        <p>{critical
          ? <strong>Urgente: regresá al puesto de carga de inmediato.</strong>
          : "Te recomendamos empezar a regresar al puesto de carga."}</p>
      </div>
      <div className="nav-rover-access-actions">
        <button type="button" className="bt prim-btn" disabled={manualControl} onClick={() => setAlert(null)}>OK</button>
      </div>
      {manualControl && <p>Salí del modo manual para confirmar el aviso.</p>}
    </aside>
  );
}
