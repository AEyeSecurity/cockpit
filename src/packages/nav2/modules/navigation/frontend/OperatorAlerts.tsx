import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ModuleContext } from "../../../../../core/types/module";
import { OperatorNotice, useManualControl } from "../../../shared/OperatorNotice";
import { BatteryAlert } from "../../telemetry/frontend/BatteryAlert";
import type { ConnectionService } from "../service/impl/ConnectionService";
import type { NavigationService, NavigationState } from "../service/impl/NavigationService";
import { type RoverAccess, useRoverAccessContext } from "./RoverAccessDialog";

export function RoverDisplacedNotice({ control, manualControl }: {
  control: RoverAccess;
  manualControl: boolean;
}): JSX.Element | null {
  if (!control.access?.displaced) return null;
  return (
    <OperatorNotice title="Otro operador tomó el control del Rover" tone="warn" manualControl={manualControl}
      busy={control.busy} onConfirm={() => void control.choose("acknowledge")}>
      <p>Pasaste a modo espectador. Podés seguir viendo el mapa y las cámaras.</p>
      {control.error && <p>{control.error}</p>}
    </OperatorNotice>
  );
}

export function OperatorAlerts({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const manualControl = useManualControl(runtime);
  const access = useRoverAccessContext();
  const [lostConnection, setLostConnection] = useState("");
  const [blockedRoute, setBlockedRoute] = useState<string | null>(null);
  const [rejectedLoop, setRejectedLoop] = useState(false);

  useEffect(() => {
    const connectionId = runtime.services.has("nav2.service.connection")
      ? "nav2.service.connection" : "service.connection";
    if (!runtime.services.has(connectionId)) return;

    const connection = runtime.getService<ConnectionService>(connectionId);
    const navigation = runtime.services.has("nav2.service.navigation")
      ? runtime.getService<NavigationService>("nav2.service.navigation") : null;
    let connected = connection.getState().connected;
    let wasBlocked = false;
    let reportedPreparation: NavigationState["submittedRoutePreparation"];
    const stopConnection = connection.subscribe((state) => {
      if (connected && !state.connected) {
        if (state.lastError) setLostConnection(state.lastError);
        reportedPreparation = navigation?.getState().submittedRoutePreparation;
      }
      connected = state.connected;
    });
    const stopNavigation = navigation?.subscribe(({ routeMission, routePreparationResult, submittedRoutePreparation }) => {
      if (!connected) return;
      const blocked = routeMission.blockedState === "NEEDS_OPERATOR";
      if (blocked && !wasBlocked) setBlockedRoute(routeMission.blockedReasonText);
      wasBlocked = blocked;

      if (!submittedRoutePreparation || submittedRoutePreparation === reportedPreparation) return;
      const { id } = submittedRoutePreparation;
      if (routeMission.preparationId !== undefined && routeMission.preparationId > id) return;
      const rejection = routePreparationResult?.id === id ? routePreparationResult.rejection
        : routeMission.preparationId === id ? routeMission.preparationRejection : undefined;
      if (rejection === "no_near_segment") {
        reportedPreparation = submittedRoutePreparation;
        setRejectedLoop(true);
      }
    });

    return () => {
      stopConnection();
      stopNavigation?.();
    };
  }, [runtime]);

  return createPortal(
    <div className="nav-operator-notices" data-manual-control={manualControl}>
      {lostConnection && <OperatorNotice title="Conexión perdida" tone="critical" manualControl={manualControl}
        onConfirm={() => setLostConnection("")}>
        <p>Cockpit perdió la conexión y no puede confirmar el estado del Rover. Comprobá que esté encendido y pulsá <strong>Conectar</strong>.</p>
        <p>Detalle: {lostConnection}</p>
      </OperatorNotice>}
      {access && <RoverDisplacedNotice control={access} manualControl={manualControl} />}
      {blockedRoute !== null && <OperatorNotice title="La ruta no pudo continuar" tone="critical" manualControl={manualControl}
        onConfirm={() => setBlockedRoute(null)}>
        {blockedRoute && <p>{blockedRoute}</p>}
        <p>Revisá el recorrido en el mapa y el entorno del Rover. Si el paso está libre, podés cancelar la misión y volver a iniciarla.</p>
      </OperatorNotice>}
      {rejectedLoop && <OperatorNotice title="La ruta en bucle no pudo arrancar" tone="warn" manualControl={manualControl}
        onConfirm={() => setRejectedLoop(false)}>
        <p>El Rover está demasiado lejos de un tramo válido. Acercalo al recorrido cuando sea seguro o desmarcá <strong>Repetir la ruta al terminar</strong> para recorrerla una vez.</p>
      </OperatorNotice>}
      <BatteryAlert runtime={runtime} />
    </div>,
    document.body
  );
}
