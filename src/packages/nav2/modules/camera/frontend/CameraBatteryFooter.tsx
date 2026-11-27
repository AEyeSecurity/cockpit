import { useEffect, useState } from "react";
import { ShellCommands } from "../../../../../app/shellCommands";
import type { ModuleContext } from "../../../../../core/types/module";
import { getBatteryPresentation } from "../../map/frontend/batteryPresentation";
import type { NavigationService } from "../../navigation/service/impl/NavigationService";
import type { TelemetryService } from "../../telemetry/service/impl/TelemetryService";

export function CameraBatteryFooter({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const telemetry = runtime.services.get("service.telemetry")?.service as TelemetryService | undefined;
  const navigation = runtime.services.get("service.navigation")?.service as NavigationService | undefined;
  const [status, setStatus] = useState(() => telemetry?.getSnapshot().robotStatus);
  const [lowBatteryActive, setLowBatteryActive] = useState(() => navigation?.getState().routeMission?.lowBatteryActive === true);

  useEffect(() => telemetry?.subscribeTelemetry((snapshot) => setStatus(snapshot.robotStatus)), [telemetry]);
  useEffect(() => navigation?.subscribe((state) => setLowBatteryActive(state.routeMission?.lowBatteryActive === true)), [navigation]);

  const batteryPct = status?.batteryPct ?? null;
  const batteryVoltageV = status?.batteryVoltageV ?? null;
  const presentation = getBatteryPresentation({
    batteryPct,
    batteryVoltageV,
    lowBatteryActive,
    connected: status?.connected === true,
    batteryState: status?.batteryState ?? "",
    batteryMissionState: status?.batteryMissionState ?? "",
    batteryReturnHomeRecommended: status?.batteryReturnHomeRecommended ?? null,
    batteryPresent: status?.batteryPresent ?? null
  });
  const reading = presentation.tone === "off" ? "—" : [
    batteryVoltageV === null ? null : batteryVoltageV.toFixed(2) + " V",
    batteryPct === null ? null : batteryPct.toFixed(1) + " %"
  ].filter(Boolean).join(" · ");

  return <button
    type="button"
    className={"camera-battery-footer tone-" + presentation.tone}
    title={presentation.badgeLabel + " · " + presentation.detail}
    onClick={() => void runtime.commands.execute(ShellCommands.openWorkspace, "workspace.map")}
  >
    Batería · {reading}
  </button>;
}
