import type { RouteMissionStateData } from "./service/impl/NavigationService";

export interface RouteMissionActivityState {
  running: boolean;
  activeVisual: boolean;
  hasHistory: boolean;
  isTerminal: boolean;
}

export function normalizeRouteMissionStatus(status: string): string {
  return String(status ?? "").replace(/\s+\[[^\]]+\]\s*$/u, "").trim().toLowerCase();
}

export function isRouteMissionTerminal(routeMission: RouteMissionStateData): boolean {
  const status = normalizeRouteMissionStatus(routeMission.status);
  return (
    status.includes("completed") ||
    status.includes("done") ||
    status.includes("succeeded") ||
    status.includes("cancelled") ||
    status.includes("canceled") ||
    status.includes("failed") ||
    status.includes("aborted") ||
    routeMission.returnHomePhase === "completed" ||
    routeMission.returnHomePhase === "unavailable"
  );
}

export function hasRouteMissionHistory(routeMission: RouteMissionStateData): boolean {
  const status = normalizeRouteMissionStatus(routeMission.status);
  return (
    routeMission.inputWaypointCount > 0 ||
    routeMission.expandedWaypointCount > 0 ||
    routeMission.currentStartIndex > 0 ||
    routeMission.currentTargetIndex > 0 ||
    routeMission.activeChunkSize > 0 ||
    routeMission.missionWaypoints.length > 0 ||
    routeMission.activeChunkWaypoints.length > 0 ||
    routeMission.blockedState.length > 0 ||
    routeMission.actionActive ||
    routeMission.returnHomeRequested ||
    routeMission.returnHomeActive ||
    routeMission.lowBatteryActive ||
    routeMission.homeAvailable ||
    routeMission.homeWaypoint !== null ||
    routeMission.loop ||
    (status.length > 0 && status !== "idle")
  );
}

export function isRouteMissionIdleSnapshot(routeMission: RouteMissionStateData): boolean {
  const status = normalizeRouteMissionStatus(routeMission.status);
  return (
    !routeMission.active &&
    !routeMission.paused &&
    !routeMission.loop &&
    !routeMission.lowBatteryActive &&
    !routeMission.returnHomeRequested &&
    !routeMission.returnHomeActive &&
    routeMission.returnHomeExitWaypointIndex < 0 &&
    routeMission.returnHomePhase === "idle" &&
    !routeMission.homeAvailable &&
    routeMission.homeWaypoint === null &&
    status === "idle" &&
    routeMission.inputWaypointCount === 0 &&
    routeMission.expandedWaypointCount === 0 &&
    routeMission.currentStartIndex === 0 &&
    routeMission.currentTargetIndex === 0 &&
    routeMission.activeChunkSize === 0 &&
    routeMission.legSpacingM === 0 &&
    routeMission.chunkSpanM === 0 &&
    routeMission.chunkMaxWaypoints === 0 &&
    routeMission.blockedState.length === 0 &&
    routeMission.blockedReasonCode.length === 0 &&
    routeMission.blockedReasonText.length === 0 &&
    routeMission.blockedRetryAttempt === 0 &&
    routeMission.blockedRetryMaxAttempts === 0 &&
    routeMission.blockedWaitRemainingS === 0 &&
    !routeMission.actionActive &&
    routeMission.actionWaypointIndex === 0 &&
    routeMission.actionType.length === 0 &&
    routeMission.actionRemainingS === 0 &&
    routeMission.missionWaypoints.length === 0 &&
    routeMission.activeChunkWaypoints.length === 0
  );
}

export function shouldPreserveRouteMissionSnapshot(
  previous: RouteMissionStateData,
  incoming: RouteMissionStateData,
  goalActiveHint?: boolean
): boolean {
  if (!isRouteMissionIdleSnapshot(incoming)) return false;
  if (isRouteMissionTerminal(previous)) return false;
  if (!hasRouteMissionHistory(previous)) return false;
  if (goalActiveHint === false) return false;
  return goalActiveHint === true || previous.active || previous.paused;
}

export function getRouteMissionActivityState(
  routeMission: RouteMissionStateData,
  goalActive: boolean
): RouteMissionActivityState {
  const hasHistory = hasRouteMissionHistory(routeMission);
  const isTerminal = isRouteMissionTerminal(routeMission);
  const running = routeMission.active || routeMission.paused || (goalActive && hasHistory && !isTerminal);
  return {
    running,
    activeVisual: running || routeMission.blockedState.length > 0,
    hasHistory,
    isTerminal
  };
}
