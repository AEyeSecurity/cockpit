import type { NavigationState } from "./service/impl/NavigationService";

type BlockedFields = Pick<NavigationState["routeMission"],
  "blockedState" | "blockedReasonCode" | "blockedReasonText" |
  "blockedRetryAttempt" | "blockedRetryMaxAttempts" | "blockedWaitRemainingS">;

/** Presentation shared by the navigation panel and the map; ROS owns the clock. */
export function describeRouteBlock(mission?: BlockedFields | null): {
  title: string; detail: string; tone: "error" | "paused";
} | null {
  if (!mission?.blockedState || mission.blockedState === "CLEAR") return null;
  const terminal = mission.blockedState === "NEEDS_OPERATOR";
  const maneuver = ["PLANNER_U_TURN", "PLANNER_LOOP", "MANEUVER_GEOMETRY_INVALID"]
    .includes(mission.blockedReasonCode);
  const reason = mission.blockedReasonText || mission.blockedReasonCode || "Camino bloqueado";
  const retryMax = Math.max(0, Math.round(mission.blockedRetryMaxAttempts));
  const retry = Math.max(0, Math.round(mission.blockedRetryAttempt));
  const retryText = !maneuver && !terminal && retryMax > 0
    ? `retry ${Math.min(retry + 1, retryMax)}/${retryMax}` : "";
  const remaining = Math.max(0, Number(mission.blockedWaitRemainingS));
  const waitText = !terminal && remaining > 0 ? `${Math.ceil(remaining)}s` : "";
  return {
    title: terminal ? "Se necesita intervención" : maneuver ? "Esperando camino alternativo"
      : mission.blockedState === "RECOVERING" ? "Reintentando la ruta" : "Camino bloqueado",
    detail: [reason, retryText, waitText].filter(Boolean).join(" · "),
    tone: terminal ? "error" : "paused"
  };
}
