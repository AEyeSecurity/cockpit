import { useEffect, useState } from "react";
import type { ModuleContext } from "../../../../../core/types/module";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import { OperatorNotice, useManualControl } from "../../../shared/OperatorNotice";
import { batteryChargeWarning } from "../../../shared/batteryCharge";
import type { TelemetryService } from "../service/impl/TelemetryService";

const UNRELIABLE_STATES = new Set(["UNAVAILABLE", "STALE", "LINK_STALE", "SUSPECT"]);

export function BatteryAlert({ runtime }: { runtime: ModuleContext }): JSX.Element | null {
  const [alert, setAlert] = useState<{ tone: "warn" | "critical"; percentage: number } | null>(null);

  const manualControl = useManualControl(runtime);

  useEffect(() => {
    if (!runtime.services.has("nav2.service.telemetry") || !runtime.services.has("nav2.service.connection")) return;
    const telemetry = runtime.getService<TelemetryService>("nav2.service.telemetry");
    const connection = runtime.getService<ConnectionService>("nav2.service.connection");

    let shown: ReturnType<typeof batteryChargeWarning> = null;
    let connected = false;
    const stopConnection = connection.subscribe((state) => { connected = state.connected; });
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
      stopTelemetry();
      stopConnection();
    };
  }, [runtime]);

  if (!alert) return null;
  const critical = alert.tone === "critical";
  return (
    <OperatorNotice title={critical ? "Batería crítica" : "Batería baja"} tone={alert.tone}
      manualControl={manualControl} onConfirm={() => setAlert(null)}>
      <p>El Rover registró {alert.percentage.toFixed(1)} % de carga.</p>
      <p>{critical
        ? <strong>Urgente: regresá al puesto de carga de inmediato.</strong>
        : "Te recomendamos empezar a regresar al puesto de carga."}</p>
    </OperatorNotice>
  );
}
