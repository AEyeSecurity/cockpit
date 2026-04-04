import type { RobotStatus } from "../../dispatcher/impl/RobotDispatcher";
import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";
import type { EventBus } from "../../../../core/events/eventBus";

export interface TelemetryEvent {
  level: string;
  text: string;
  timestamp: number;
}

export interface TelemetrySnapshot {
  robotStatus: RobotStatus;
  robotPose: {
    lat: number;
    lon: number;
    headingDeg: number;
  } | null;
  cmdVelSafe: string;
  goalActive: boolean;
  controlLocked: boolean;
  controlLockReason: string;
  recentEvents: TelemetryEvent[];
  alerts: TelemetryEvent[];
}

export class TelemetryService {
  private readonly listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  private snapshot: TelemetrySnapshot = {
    robotStatus: {
      batteryPct: 0,
      mode: "disconnected",
      connected: false
    },
    robotPose: null,
    cmdVelSafe: "n/a",
    goalActive: false,
    controlLocked: false,
    controlLockReason: "",
    recentEvents: [],
    alerts: []
  };

  constructor(private readonly robotDispatcher: RobotDispatcher, eventBus: EventBus) {
    this.robotDispatcher.subscribeRobotStatus((status) => {
      this.snapshot = {
        ...this.snapshot,
        robotStatus: status
      };
      this.emit();
    });

    this.robotDispatcher.subscribeState((message) => {
      this.applyNavTelemetryPayload(message);
      this.applyPosePayload(message.robot_pose as Record<string, unknown> | null);
      if (Array.isArray(message.alerts)) {
        this.setAlerts(
          message.alerts
            .map((entry) => this.normalizeTelemetryEvent(entry))
            .filter((entry): entry is TelemetryEvent => entry !== null)
        );
      }
      if (Array.isArray(message.recent_events)) {
        this.setRecentEvents(
          message.recent_events
            .map((entry) => this.normalizeTelemetryEvent(entry))
            .filter((entry): entry is TelemetryEvent => entry !== null)
        );
      }
      this.emit();
    });

    this.robotDispatcher.subscribeNavTelemetry((message) => {
      this.applyNavTelemetryPayload(message);
      this.emit();
    });

    this.robotDispatcher.subscribeNavEvent((message) => {
      const event = this.normalizeTelemetryEvent(message.event);
      if (!event) return;
      this.pushEvent(event);
    });

    this.robotDispatcher.subscribeNavAlerts((message) => {
      if (!Array.isArray(message.alerts)) return;
      this.setAlerts(
        message.alerts
          .map((entry) => this.normalizeTelemetryEvent(entry))
          .filter((entry): entry is TelemetryEvent => entry !== null)
      );
      this.emit();
    });

    this.robotDispatcher.subscribeRobotPose((message) => {
      this.applyPosePayload(message.pose as Record<string, unknown> | null);
      this.emit();
    });

    eventBus.on<{ level: string; text: string; timestamp: number }>("console.event", (event) => {
      this.pushEvent({
        level: event.level,
        text: event.text,
        timestamp: event.timestamp
      });
    });
  }

  subscribeRobotStatus(callback: (status: RobotStatus) => void): () => void {
    return this.robotDispatcher.subscribeRobotStatus(callback);
  }

  getSnapshot(): TelemetrySnapshot {
    return {
      robotStatus: { ...this.snapshot.robotStatus },
      robotPose: this.snapshot.robotPose ? { ...this.snapshot.robotPose } : null,
      cmdVelSafe: this.snapshot.cmdVelSafe,
      goalActive: this.snapshot.goalActive,
      controlLocked: this.snapshot.controlLocked,
      controlLockReason: this.snapshot.controlLockReason,
      recentEvents: [...this.snapshot.recentEvents],
      alerts: [...this.snapshot.alerts]
    };
  }

  subscribeTelemetry(callback: (snapshot: TelemetrySnapshot) => void): () => void {
    this.listeners.add(callback);
    callback(this.getSnapshot());
    return () => {
      this.listeners.delete(callback);
    };
  }

  pushEvent(event: TelemetryEvent): void {
    const nextRecent = [event, ...this.snapshot.recentEvents].slice(0, 40);
    const nextAlerts =
      event.level === "error" || event.level === "warn" ? this.mergeAlerts([event], this.snapshot.alerts) : this.snapshot.alerts;

    this.snapshot = {
      ...this.snapshot,
      recentEvents: nextRecent,
      alerts: nextAlerts
    };
    this.emit();
  }

  private setAlerts(alerts: TelemetryEvent[]): void {
    this.snapshot = {
      ...this.snapshot,
      alerts: this.mergeAlerts(alerts, this.snapshot.alerts)
    };
  }

  private setRecentEvents(events: TelemetryEvent[]): void {
    this.snapshot = {
      ...this.snapshot,
      recentEvents: events.slice(0, 80)
    };
  }

  private normalizeTelemetryEvent(raw: unknown): TelemetryEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const text = String(value.text ?? value.message ?? value.msg ?? "");
    if (!text) return null;
    return {
      level: String(value.level ?? value.severity ?? "info").toLowerCase(),
      text,
      timestamp: Number(value.timestamp ?? value.stamp_ms ?? Date.now())
    };
  }

  private applyPosePayload(raw: Record<string, unknown> | null): void {
    if (!raw) return;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this.snapshot = {
      ...this.snapshot,
      robotPose: {
        lat,
        lon,
        headingDeg: Number(raw.heading_deg ?? raw.headingDeg ?? 0)
      }
    };
  }

  private applyNavTelemetryPayload(raw: Record<string, unknown>): void {
    const mode = String(raw.mode ?? this.snapshot.robotStatus.mode);
    const battery = Number(raw.battery_pct ?? raw.batteryPct ?? this.snapshot.robotStatus.batteryPct);
    const connected = raw.connected === true || this.snapshot.robotStatus.connected;
    this.snapshot = {
      ...this.snapshot,
      robotStatus: {
        mode,
        batteryPct: Number.isFinite(battery) ? battery : this.snapshot.robotStatus.batteryPct,
        connected
      },
      cmdVelSafe: String(raw.cmd_vel_safe ?? this.snapshot.cmdVelSafe),
      goalActive: raw.goal_active === true ? true : raw.goal_active === false ? false : this.snapshot.goalActive,
      controlLocked:
        raw.control_locked === true ? true : raw.control_locked === false ? false : this.snapshot.controlLocked,
      controlLockReason: String(raw.control_lock_reason ?? this.snapshot.controlLockReason)
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private mergeAlerts(incoming: TelemetryEvent[], existing: TelemetryEvent[]): TelemetryEvent[] {
    const keyed = new Map<string, TelemetryEvent>();
    [...incoming, ...existing].forEach((entry) => {
      const level = String(entry.level ?? "info").toLowerCase();
      const text = String(entry.text ?? "");
      const timestamp = Number(entry.timestamp ?? 0);
      const key = `${timestamp}|${level}|${text}`;
      if (!keyed.has(key)) {
        keyed.set(key, {
          level,
          text,
          timestamp
        });
      }
    });
    return [...keyed.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 80);
  }
}
