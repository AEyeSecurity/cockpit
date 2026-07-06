import type { PatrolMissionProfile } from "./service/impl/NavigationService";

export interface PatrolProfileReadiness {
  entryValid: boolean;
  isReady: boolean;
  missingRequirements: string[];
  profileConfigured: boolean;
  summary: string;
}

export function isPatrolEntryValid(profile: PatrolMissionProfile): boolean {
  return profile.departEntryLoopIndex >= 0 && profile.departEntryLoopIndex < profile.loopWaypoints.length;
}

export function getPatrolProfileReadiness(profile: PatrolMissionProfile): PatrolProfileReadiness {
  const entryValid = isPatrolEntryValid(profile);
  const missingRequirements = [
    ...(profile.loopWaypoints.length >= 2 ? [] : ["LOOP"]),
    ...(profile.homeWaypoint ? [] : ["HOME"]),
    ...(entryValid ? [] : ["ENTRY"])
  ];
  return {
    entryValid,
    isReady: missingRequirements.length === 0,
    missingRequirements,
    profileConfigured:
      profile.loopWaypoints.length > 0 ||
      profile.returnWaypoints.length > 0 ||
      profile.departWaypoints.length > 0 ||
      profile.homeWaypoint !== null ||
      profile.departEntryLoopIndex >= 0,
    summary: `${profile.loopWaypoints.length} loop · home · entry #${profile.departEntryLoopIndex + 1}`
  };
}
