import { Nav2DispatcherBase } from "../../../../protocol/Nav2DispatcherBase";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";

export interface MissionStartRequest {
  missionId: string;
  robotId: string;
}

export interface RosbagStatus {
  active: boolean;
  profile: string;
  outputPath: string;
  logPath: string;
}

export interface MissionSessionFileInfo {
  filename: string;
  sizeBytes: number;
  lineCount: number;
  mtimeEpochMs: number;
}

export interface MissionJsonRecord {
  t?: number;
  topic?: string;
  data?: unknown;
  [key: string]: unknown;
}

export class MissionDispatcher extends Nav2DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId);
  }

  async startMission(request: MissionStartRequest): Promise<Nav2IncomingMessage> {
    return this.request("mission.start", request as never, { timeoutMs: 6000 });
  }

  async startRosbag(): Promise<Nav2IncomingMessage> {
    return this.request("start_rosbag", {}, { timeoutMs: 6000 });
  }

  async stopRosbag(): Promise<Nav2IncomingMessage> {
    return this.request("stop_rosbag", {}, { timeoutMs: 6000 });
  }

  async requestRosbagStatus(): Promise<Nav2IncomingMessage> {
    return this.request("get_rosbag_status", {}, { timeoutMs: 4000 });
  }

  async requestMissionSessions(): Promise<Nav2IncomingMessage> {
    return this.request("mission.list_sessions", {}, { timeoutMs: 5000 });
  }

  async requestMissionSession(filename: string): Promise<Nav2IncomingMessage> {
    return this.request("mission.get_session", { filename }, { timeoutMs: 7000 });
  }

  async requestMissionSessionDownload(filename: string): Promise<Nav2IncomingMessage> {
    return this.request("mission.download_session", { filename }, { timeoutMs: 7000 });
  }

  subscribeMissionStatus(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("nav_event", callback);
  }

  subscribeRosbagStatus(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("rosbag_status", callback);
  }

  subscribeMissionSessionsOnConnect(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("mission.sessions_on_connect", callback);
  }

  subscribeMissionNewSession(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("mission.new_session", callback);
  }
}
