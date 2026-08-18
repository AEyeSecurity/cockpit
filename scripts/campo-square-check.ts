/**
 * Ejercita el flujo CAMPO del cockpit contra el backend real.
 *
 * Usa el CoverageService de produccion: el cuadrado desde la pose del vehiculo,
 * el preview y el arranque. Lo unico simulado es el transporte, que en el
 * navegador es el WebSocket del cockpit y aca es el mismo WebSocket abierto desde
 * node, con el formato de mensaje que produce `encodeNav2Outgoing`.
 *
 * Uso, con sim_global_v2 y el web_zone_server arriba:
 *
 *   npx vite-node scripts/campo-square-check.ts [lado_m] [ancho_corte_m] \
 *     [--move <este_m> <norte_m>] [--resize <lado_m>] [--start]
 *
 * `--move` corre el cuadrado como lo haria el tirador del centro en el mapa y
 * `--resize` lo agranda como el tirador de la esquina opuesta; los dos re-piden
 * el preview. Sin `--start` no se mueve el vehiculo.
 * `CAMPO_DUMP=<archivo>` guarda el trazado nominal en lat/lon para compararlo
 * despues contra la odometria.
 */

import { writeFileSync } from "fs";
import WebSocket from "ws";
import { encodeNav2Outgoing, type Nav2IncomingMessage } from "../src/packages/nav2/protocol/messages";
import { CoverageService } from "../src/packages/nav2/modules/navigation/service/impl/CoverageService";
import type { RobotDispatcher } from "../src/packages/nav2/modules/navigation/dispatcher/impl/RobotDispatcher";

const URL = process.env.NAV2_WS_URL ?? "ws://127.0.0.1:8766";

interface RobotPose {
  lat: number;
  lon: number;
  headingDeg: number;
}

class WsBridge {
  private sequence = 0;
  private readonly pending = new Map<string, (message: Nav2IncomingMessage) => void>();
  private pose: RobotPose | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const robotPose = parsed.robot_pose as Record<string, unknown> | undefined;
      if (robotPose && Number.isFinite(Number(robotPose.lat))) {
        this.pose = {
          lat: Number(robotPose.lat),
          lon: Number(robotPose.lon),
          headingDeg: Number(robotPose.heading_deg ?? 0)
        };
      }
      const id = String(parsed.client_req_id ?? parsed.requestId ?? "");
      const resolve = this.pending.get(id);
      if (resolve && parsed.op === "ack") {
        this.pending.delete(id);
        resolve(parsed as Nav2IncomingMessage);
      }
    });
  }

  waitForPose(timeoutMs = 20000): Promise<RobotPose> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.pose) return resolve(this.pose);
        if (Date.now() - started > timeoutMs) return reject(new Error("sin robot_pose"));
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  request(op: string, payload: unknown, timeoutMs: number): Promise<Nav2IncomingMessage> {
    this.sequence += 1;
    const requestId = `scratch-${op}-${this.sequence}`;
    const encoded = encodeNav2Outgoing({ op, requestId, payload } as never);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`timeout en ${op}`));
      }, timeoutMs);
      this.pending.set(requestId, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.socket.send(JSON.stringify(encoded));
    });
  }

  asDispatcher(): RobotDispatcher {
    return {
      requestCoveragePreview: (field: unknown) => this.request("preview_coverage", field, 20000),
      requestStartCoverage: (field: unknown) => this.request("start_coverage", field, 30000)
    } as unknown as RobotDispatcher;
  }
}

async function main(): Promise<number> {
  const sideM = Number(process.argv[2] ?? 20);
  const cutterWidthM = Number(process.argv[3] ?? 2);
  const start = process.argv.includes("--start");
  const moveIndex = process.argv.indexOf("--move");
  const rotateIndex = process.argv.indexOf("--rotate");
  const resizeIndex = process.argv.indexOf("--resize");

  const socket = new WebSocket(URL, { maxPayload: 64 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const bridge = new WsBridge(socket);
  const pose = await bridge.waitForPose();
  console.log(`pose del vehiculo: ${pose.lat.toFixed(7)}, ${pose.lon.toFixed(7)} ` +
    `rumbo ${pose.headingDeg.toFixed(1)} deg`);

  const service = new CoverageService(bridge.asDispatcher());
  service.setRuntimeProfile("sim");
  service.setParameters({ cutterWidthM, overlapRatio: 0.15 });

  // Lo mismo que hace el boton ARMAR CUADRADO: esquina en el vehiculo, rumbo del
  // vehiculo y el lado pedido.
  service.squareFromVehiclePose(
    { lat: pose.lat, lon: pose.lon, yawDeg: pose.headingDeg },
    { sideM }
  );

  const field = service.getState().field;
  if (!field) throw new Error("el campo no quedo definido");
  console.log(`lado pedido: ${sideM} m, corte ${cutterWidthM} m`);
  console.log(`campo: ${field.fieldLengthM.toFixed(2)} x ${field.fieldWidthM.toFixed(2)} m ` +
    `rumbo ${field.startYawDeg.toFixed(1)} deg lado ${field.side}`);
  console.log(`estado: ${service.getState().lastStatus}`);

  if (moveIndex >= 0) {
    const eastM = Number(process.argv[moveIndex + 1] ?? 0);
    const northM = Number(process.argv[moveIndex + 2] ?? 0);
    const polygon = service.getState().fieldPolygon;
    const centre = {
      lat: (polygon[0]!.lat + polygon[2]!.lat) / 2,
      lon: (polygon[0]!.lon + polygon[2]!.lon) / 2
    };
    const metresPerDegLat = 111_320;
    service.moveFieldTo({
      lat: centre.lat + northM / metresPerDegLat,
      lon: centre.lon + eastM / (metresPerDegLat * Math.cos((centre.lat * Math.PI) / 180))
    });
    console.log(`movido ${eastM} m al este y ${northM} m al norte`);
    console.log(`estado: ${service.getState().lastStatus}`);
  }

  if (rotateIndex >= 0) {
    const rumboDeg = Number(process.argv[rotateIndex + 1] ?? 0);
    const polygon = service.getState().fieldPolygon;
    const centre = {
      lat: (polygon[0]!.lat + polygon[2]!.lat) / 2,
      lon: (polygon[0]!.lon + polygon[2]!.lon) / 2
    };
    const metresPerDegLat = 111_320;
    const radio = 20;
    const rad = (rumboDeg * Math.PI) / 180;
    service.rotateFieldTo({
      lat: centre.lat + (Math.sin(rad) * radio) / metresPerDegLat,
      lon:
        centre.lon +
        (Math.cos(rad) * radio) / (metresPerDegLat * Math.cos((centre.lat * Math.PI) / 180))
    });
    console.log(`girado a rumbo ${rumboDeg} grados`);
    console.log(`campo: rumbo ${service.getState().field!.startYawDeg.toFixed(1)} deg`);
  }

  if (resizeIndex >= 0) {
    // `--resize <lado> [esquina]`: se arrastra la esquina indicada hasta donde
    // deberia quedar para ese lado, igual que lo haria el tirador del mapa.
    const targetSideM = Number(process.argv[resizeIndex + 1] ?? 0);
    const esquina = Number(process.argv[resizeIndex + 2] ?? 2);
    const current = service.getState().field!;
    const metresPerDegLat = 111_320;
    const yawRad = (current.startYawDeg * Math.PI) / 180;
    const lateralSign = current.side === "left" ? 1 : -1;
    const avanceUnit = { east: Math.cos(yawRad), north: Math.sin(yawRad) };
    const costadoUnit = {
      east: -Math.sin(yawRad) * lateralSign,
      north: Math.cos(yawRad) * lateralSign
    };
    // Combinacion de avance y costado de cada esquina, en unidades de lado.
    const COMBINACION: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ];
    const [avanceFijo, costadoFijo] = COMBINACION[(esquina + 2) % 4]!;
    const [avanceMovil, costadoMovil] = COMBINACION[esquina % 4]!;
    // El ancla no se mueve: se calcula desde el arranque actual y desde ahi se
    // ubica la esquina arrastrada al lado pedido.
    const anclaEste = (avanceUnit.east * avanceFijo + costadoUnit.east * costadoFijo)
      * current.fieldLengthM;
    const anclaNorte = (avanceUnit.north * avanceFijo + costadoUnit.north * costadoFijo)
      * current.fieldLengthM;
    const deltaEste = (avanceUnit.east * (avanceMovil - avanceFijo)
      + costadoUnit.east * (costadoMovil - costadoFijo)) * targetSideM;
    const deltaNorte = (avanceUnit.north * (avanceMovil - avanceFijo)
      + costadoUnit.north * (costadoMovil - costadoFijo)) * targetSideM;
    service.resizeFieldFromCorner(
      {
        lat: current.startLat + (anclaNorte + deltaNorte) / metresPerDegLat,
        lon:
          current.startLon +
          (anclaEste + deltaEste) /
            (metresPerDegLat * Math.cos((current.startLat * Math.PI) / 180))
      },
      esquina
    );
    console.log(`lado cambiado arrastrando la esquina ${esquina}: ${targetSideM} m pedidos`);
    console.log(`estado: ${service.getState().lastStatus}`);
  }

  const preview = await service.previewCoverage();
  const metrics = preview.metrics;
  console.log("");
  console.log(`preview: ${metrics.rowCount} pasadas a ${metrics.laneSpacingM.toFixed(2)} m, ` +
    `orden [${metrics.rowVisitOrder.join(", ")}]`);
  console.log(`  giros            : ${metrics.omegaTurnCount} omega, ` +
    `${metrics.cleanUturnCount} U limpias`);
  console.log(`  radio del planner: ${metrics.plannerMinTurningRadiusM.toFixed(2)} m`);
  console.log(`  recorrido        : ${metrics.estimatedPathLengthM.toFixed(1)} m`);
  console.log(`  cabecera         : ${metrics.headlandBeforeM.toFixed(2)} m / ` +
    `${metrics.headlandAfterM.toFixed(2)} m, desborde ${metrics.lateralOverflowM.toFixed(2)} m`);
  console.log(`  metas key        : ${preview.keyWaypoints.length}`);
  console.log(`  sin cruces       : ${preview.topologySafe} (${metrics.topologyScope})`);
  console.log(`  puede arrancar   : ${service.canStartMission()}`);

  const dumpPath = process.env.CAMPO_DUMP;
  if (dumpPath) {
    writeFileSync(
      dumpPath,
      JSON.stringify(
        {
          robot_pose: pose,
          field,
          sampled: preview.sampledWaypoints.map((wp) => [wp.lat, wp.lon, wp.key]),
          key: preview.keyWaypoints.map((wp) => [wp.lat, wp.lon])
        },
        null,
        1
      ),
      "utf-8"
    );
    console.log(`  preview guardado : ${dumpPath}`);
  }


  // Chequeo geometrico: cada meta key se pasa a coordenadas del propio lote
  // —avance y costado desde la esquina de arranque— para ver si el trazado cae
  // adentro del cuadrado y corre paralelo a sus lados.
  {
    const campo = service.getState().field!;
    const metrosPorGradoLat = 111_320;
    const yaw = (campo.startYawDeg * Math.PI) / 180;
    const signo = campo.side === "left" ? 1 : -1;
    const cosLat = Math.cos((campo.startLat * Math.PI) / 180);
    let minAvance = Infinity;
    let maxAvance = -Infinity;
    let minCostado = Infinity;
    let maxCostado = -Infinity;
    for (const meta of preview.keyWaypoints) {
      const este = (meta.lon - campo.startLon) * metrosPorGradoLat * cosLat;
      const norte = (meta.lat - campo.startLat) * metrosPorGradoLat;
      const avance = este * Math.cos(yaw) + norte * Math.sin(yaw);
      const costado = (-este * Math.sin(yaw) + norte * Math.cos(yaw)) * signo;
      minAvance = Math.min(minAvance, avance);
      maxAvance = Math.max(maxAvance, avance);
      minCostado = Math.min(minCostado, costado);
      maxCostado = Math.max(maxCostado, costado);
    }
    console.log("");
    console.log(`chequeo: lado ${campo.fieldLengthM.toFixed(2)} m, rumbo ${campo.startYawDeg.toFixed(1)}, lado ${campo.side}`);
    console.log(`  avance de las metas : ${minAvance.toFixed(2)} .. ${maxAvance.toFixed(2)} m`);
    console.log(`  costado de las metas: ${minCostado.toFixed(2)} .. ${maxCostado.toFixed(2)} m`);
    const dentro =
      minAvance > -0.01 && maxAvance < campo.fieldLengthM + 0.01 &&
      minCostado > -0.01 && maxCostado < campo.fieldWidthM + 0.01;
    console.log(`  trazado dentro del cuadrado: ${dentro ? "SI" : "NO"}`);
  }

  if (start) {
    const mission = await service.sendCoverageMission();
    console.log("");
    console.log(`arranque: ${mission.inputCount} metas, ${mission.expandedCount} expandidas, ` +
      `leg_spacing ${mission.legSpacingM.toFixed(1)} m`);
    console.log(`estado: ${service.getState().lastStatus}`);
  }

  socket.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`FALLO: ${String(error)}`);
    process.exit(1);
  }
);
