import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  describeMissionRecord,
  explainMissionRecord,
  missionRecordSeverity
} from "../packages/nav2/modules/debug/frontend/index";
import type { MissionJsonRecord } from "../packages/nav2/modules/debug/service/impl/MissionService";

const MISSION_DIR = "/home/franco/Descargas/mision";

function loadRecords(filename: string): MissionJsonRecord[] {
  return readFileSync(join(MISSION_DIR, filename), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MissionJsonRecord);
}

describe("mission explanation fallback", () => {
  it("explains unknown errors and warnings with a generic plain-language text", () => {
    const unknownError: MissionJsonRecord = {
      t: 1781120081.7,
      topic: "/rosout",
      data: { level: 40, name: "lidar_driver", msg: "packet CRC mismatch on ring buffer 3" }
    };
    const unknownWarning: MissionJsonRecord = {
      t: 1781120081.8,
      topic: "/diagnostics",
      data: { name: "power/battery_monitor", level: 1, message: "cell imbalance above threshold" }
    };
    expect(missionRecordSeverity(unknownError)).toBe("error");
    expect(explainMissionRecord(unknownError)).toContain("lidar_driver");
    expect(explainMissionRecord(unknownError)).not.toHaveLength(0);
    expect(missionRecordSeverity(unknownWarning)).toBe("warning");
    expect(explainMissionRecord(unknownWarning)).toContain("battery_monitor");
  });
});

describe.skipIf(!existsSync(MISSION_DIR))("mission explanations against real session files", () => {
  const files = existsSync(MISSION_DIR)
    ? readdirSync(MISSION_DIR).filter((name) => name.endsWith(".jsonl"))
    : [];

  it("explains every record in plain language, including telemetry", () => {
    const unexplained: string[] = [];
    for (const file of files) {
      console.log(`\n=== ${file} ===`);
      for (const record of loadRecords(file)) {
        const topic = String(record.topic ?? "");
        if (topic.startsWith("system/")) continue;
        const severity = missionRecordSeverity(record);
        const description = describeMissionRecord(record);
        const explanation = explainMissionRecord(record);
        console.log(`[${severity.toUpperCase()}] ${description}`);
        console.log(`   -> ${explanation || "(SIN EXPLICACION)"}`);
        if (!explanation) unexplained.push(`${file}: [${severity}] ${description}`);
      }
    }
    expect(unexplained, `Eventos sin explicación:\n${unexplained.join("\n")}`).toEqual([]);
  });
});
