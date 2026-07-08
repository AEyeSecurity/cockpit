import type {
  PatrolMissionProfile,
  PatrolMissionStateData
} from "../../navigation/service/impl/NavigationService";
import { getPatrolProfileReadiness } from "../../navigation/patrolProfileReadiness";

export type PatrolPresentationTone = "idle" | "ready" | "active";

export interface PatrolPresentation {
  title: string;
  badgeLabel: string;
  detail: string;
  secondaryDetail: string | null;
  tone: PatrolPresentationTone;
}

function formatConnectorCounts(loopCount: number, returnCount: number, departCount: number): string {
  return `${loopCount} loop · ${returnCount} return · ${departCount} depart`;
}

function hasBackendPatrolData(mission: PatrolMissionStateData): boolean {
  return (
    mission.active ||
    mission.phase !== "idle" ||
    mission.homeAvailable ||
    mission.loopWaypoints.length > 0 ||
    mission.returnWaypoints.length > 0 ||
    mission.departWaypoints.length > 0
  );
}

export function getPatrolPresentation(
  profile: PatrolMissionProfile,
  mission: PatrolMissionStateData | null
): PatrolPresentation {
  const readiness = getPatrolProfileReadiness(profile);
  if (mission && hasBackendPatrolData(mission)) {
    return {
      title: "Patrol",
      badgeLabel: mission.phase || "active",
      detail: formatConnectorCounts(
        mission.loopWaypoints.length,
        mission.returnWaypoints.length,
        mission.departWaypoints.length
      ),
      secondaryDetail: mission.status && mission.status !== mission.phase ? mission.status : null,
      tone: mission.active ? "active" : "ready"
    };
  }

  if (readiness.isReady) {
    return {
      title: "Patrol",
      badgeLabel: "Ready",
      detail: "Ready to start",
      secondaryDetail: readiness.summary,
      tone: "ready"
    };
  }

  return {
    title: "Patrol",
    badgeLabel: "Setup",
    detail: `Missing: ${readiness.missingRequirements.join(", ")}`,
    secondaryDetail: null,
    tone: "idle"
  };
}
