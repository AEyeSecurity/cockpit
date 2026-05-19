import type { MissionDispatcher } from "../../dispatcher/impl/MissionDispatcher";
import type { MissionStartRequest } from "../../dispatcher/impl/MissionDispatcher";
import type { MissionJsonRecord } from "../../dispatcher/impl/MissionDispatcher";
import type { MissionSessionFileInfo } from "../../dispatcher/impl/MissionDispatcher";
import type { RosbagStatus } from "../../dispatcher/impl/MissionDispatcher";

export type { MissionJsonRecord, MissionSessionFileInfo } from "../../dispatcher/impl/MissionDispatcher";

export class MissionService {
  constructor(private readonly missionDispatcher: MissionDispatcher) {}

  async startMission(input: MissionStartRequest): Promise<void> {
    if (!input.missionId.trim() || !input.robotId.trim()) {
      throw new Error("missionId and robotId are required");
    }
    const response = await this.missionDispatcher.startMission(input);
    if (response.ok === false) {
      throw new Error(response.error ?? "Mission start failed");
    }
  }

  subscribeMissionStatus(callback: (text: string) => void): () => void {
    return this.missionDispatcher.subscribeMissionStatus((message) => {
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      callback(String(payload.status ?? "unknown"));
    });
  }

  async startRosbag(): Promise<RosbagStatus> {
    const response = await this.missionDispatcher.startRosbag();
    if (response.ok === false) {
      throw new Error(response.error ?? "Start rosbag failed");
    }
    return this.parseRosbagStatus(response);
  }

  async stopRosbag(): Promise<RosbagStatus> {
    const response = await this.missionDispatcher.stopRosbag();
    if (response.ok === false) {
      throw new Error(response.error ?? "Stop rosbag failed");
    }
    return this.parseRosbagStatus(response);
  }

  async getRosbagStatus(): Promise<RosbagStatus> {
    const response = await this.missionDispatcher.requestRosbagStatus();
    if (response.ok === false) {
      throw new Error(response.error ?? "Rosbag status failed");
    }
    return this.parseRosbagStatus(response);
  }

  async listMissionSessions(): Promise<MissionSessionFileInfo[]> {
    const response = await this.missionDispatcher.requestMissionSessions();
    if (response.ok === false) {
      throw new Error(response.error ?? "Mission sessions failed");
    }
    return this.parseMissionSessionList(response);
  }

  async getMissionSession(filename: string): Promise<MissionJsonRecord[]> {
    const response = await this.missionDispatcher.requestMissionSession(filename);
    if (response.ok === false) {
      throw new Error(response.error ?? "Mission session failed");
    }
    return this.parseMissionLines(response);
  }

  async downloadMissionSession(filename: string): Promise<MissionJsonRecord[]> {
    const response = await this.missionDispatcher.requestMissionSessionDownload(filename);
    if (response.ok === false) {
      throw new Error(response.error ?? "Mission session download failed");
    }
    return this.parseMissionLines(response);
  }

  subscribeRosbagStatus(callback: (status: RosbagStatus) => void): () => void {
    return this.missionDispatcher.subscribeRosbagStatus((message) => {
      callback(this.parseRosbagStatus(message));
    });
  }

  subscribeMissionSessionsOnConnect(callback: (sessions: MissionSessionFileInfo[]) => void): () => void {
    return this.missionDispatcher.subscribeMissionSessionsOnConnect((message) => {
      callback(this.parseMissionSessionList(message));
    });
  }

  subscribeMissionNewSession(callback: (filename: string, lines: MissionJsonRecord[]) => void): () => void {
    return this.missionDispatcher.subscribeMissionNewSession((message) => {
      const source = this.payloadSource(message);
      callback(String(source.filename ?? ""), this.parseMissionLines(message));
    });
  }

  private parseRosbagStatus(payload: unknown): RosbagStatus {
    const value = (payload ?? {}) as Record<string, unknown>;
    const payloadObject =
      value.payload && typeof value.payload === "object" ? (value.payload as Record<string, unknown>) : null;
    const source = (value.rosbag && typeof value.rosbag === "object"
      ? (value.rosbag as Record<string, unknown>)
      : payloadObject ?? value) as Record<string, unknown>;
    return {
      active: source.active === true,
      profile: String(source.profile ?? "core"),
      outputPath: String(source.output_path ?? source.output_dir ?? source.outputPath ?? "n/a"),
      logPath: String(source.log_path ?? source.logPath ?? "n/a")
    };
  }

  private parseMissionSessionList(payload: unknown): MissionSessionFileInfo[] {
    const source = this.payloadSource(payload);
    const sessions = Array.isArray(source.sessions) ? source.sessions : [];
    return sessions
      .filter((session): session is Record<string, unknown> => this.isRecord(session))
      .map((session) => ({
        filename: String(session.filename ?? ""),
        sizeBytes: this.toNumber(session.size_bytes ?? session.sizeBytes ?? session.size ?? 0),
        lineCount: this.toNumber(session.line_count ?? session.lineCount ?? session.lines ?? 0),
        mtimeEpochMs: this.toNumber(session.mtime_epoch_ms ?? session.mtimeEpochMs ?? session.mtime_ms ?? 0)
      }))
      .filter((session) => session.filename.length > 0);
  }

  private parseMissionLines(payload: unknown): MissionJsonRecord[] {
    const source = this.payloadSource(payload);
    const lines = Array.isArray(source.lines)
      ? source.lines
      : Array.isArray(source.records)
        ? source.records
        : [];
    return lines.filter((line): line is MissionJsonRecord => this.isRecord(line));
  }

  private payloadSource(payload: unknown): Record<string, unknown> {
    const value = this.isRecord(payload) ? payload : {};
    return this.isRecord(value.payload) ? { ...value, ...value.payload } : value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private toNumber(value: unknown): number {
    const next = typeof value === "number" ? value : Number(value);
    return Number.isFinite(next) ? next : 0;
  }
}
