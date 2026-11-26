import { createConnection } from "node:net";
import { execFile } from "node:child_process";

const bootIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function parseResponse(response) {
  const result = JSON.parse(response);
  if (!bootIdPattern.test(result?.boot_id ?? "")) throw new Error("Invalid boot ID");
  return result;
}

export function createSshRebootExchange(host, run = execFile) {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host)) throw new Error("Invalid host reboot SSH address");
  const args = [
    "-F", "/dev/null", "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=4",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=/run/cockpit-reboot-ssh/known_hosts",
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "IdentityAgent=none",
    "-o", "IdentitiesOnly=yes",
    "-i", "/run/cockpit-reboot-ssh/id_ed25519",
    "salus-reboot@" + host,
    "maintenance"
  ];
  return command => new Promise((resolve, reject) => {
    const process = run("/usr/bin/ssh", args, { timeout: 9000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(parseResponse(stdout));
      } catch (failure) {
        reject(failure);
      }
    });
    process.stdin.on("error", reject);
    process.stdin.end(command + "\n");
  });
}

function exchange(path, command) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path }, () => socket.write(command + "\n"));
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(6500, () => socket.destroy(new Error("Reboot socket timed out")));
    socket.on("error", reject);
    socket.on("data", chunk => {
      response += chunk;
      if (response.length > 512) socket.destroy(new Error("Invalid reboot response"));
    });
    socket.on("end", () => {
      try {
        resolve(parseResponse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function createHostReboot({ path, sshHost }, HttpError) {
  const request = sshHost ? createSshRebootExchange(sshHost) : command => exchange(path, command);
  let pending = false;
  return async () => {
    if (pending) throw new HttpError(409, "Ya hay una solicitud de reinicio en curso.");
    pending = true;
    try {
      const status = await request("status").catch(() => null);
      if (status?.state !== "ready") throw new HttpError(503, "El servicio de reinicio del rover no está disponible.");
      const result = await request("reboot " + status.boot_id).catch(() => null);
      if (!result) throw new HttpError(503, "No se pudo confirmar si se inició el reinicio. Verificá el estado del rover antes de volver a intentar.");
      if (result.state !== "requested" || result.boot_id !== status.boot_id) {
        throw new HttpError(503, "La computadora del rover rechazó la solicitud de reinicio.");
      }
      return { state: "requested" };
    } finally {
      pending = false;
    }
  };
}
