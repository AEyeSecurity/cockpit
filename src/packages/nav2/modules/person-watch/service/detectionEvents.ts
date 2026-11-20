import type { PersonAlert } from "./PersonWatchService";

const EVENT_WINDOW_MS = 4000;

interface DetectionEvent {
  first: PersonAlert;
  alerts: PersonAlert[];
}

export const detectionTime = (alert: PersonAlert): number => alert.event_ms ?? alert.frame_ms ?? alert.timestamp_ms;

export function groupDetectionEvents(alerts: PersonAlert[]): DetectionEvent[] {
  const chronological = [...alerts].sort((left, right) => detectionTime(left) - detectionTime(right) || left.id.localeCompare(right.id));
  const events: DetectionEvent[] = [];
  for (const alert of chronological) {
    const current = events.at(-1);
    if (current && detectionTime(alert) - detectionTime(current.first) <= EVENT_WINDOW_MS) current.alerts.push(alert);
    else events.push({ first: alert, alerts: [alert] });
  }
  return events.reverse();
}
