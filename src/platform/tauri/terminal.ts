export interface TerminalSessionInfo {
  sessionId: string;
  host: string;
  local: boolean;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

interface RawTerminalSessionInfo {
  session_id: string;
  host: string;
  local: boolean;
}

interface RawTerminalOutputEvent {
  session_id?: unknown;
  data?: unknown;
}

export class TerminalRuntimeError extends Error {
  readonly code = "terminal_runtime_error";

  constructor(message: string) {
    super(message);
    this.name = "TerminalRuntimeError";
  }
}

function debugLog(message: string, details?: unknown): void {
  if (details === undefined) {
    console.debug(`[terminal-debug] ${message}`);
    return;
  }
  console.debug(`[terminal-debug] ${message}`, details);
}

function normalizeSessionInfo(payload: RawTerminalSessionInfo | null | undefined): TerminalSessionInfo | null {
  if (!payload || typeof payload.session_id !== "string" || typeof payload.host !== "string") {
    return null;
  }
  return {
    sessionId: payload.session_id,
    host: payload.host,
    local: payload.local === true
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message.length > 0) {
      return message;
    }
  }
  return fallback;
}

async function invokeTerminalCommand<TResult>(
  command: string,
  payload: Record<string, unknown> | undefined,
  fallbackErrorMessage: string
): Promise<TResult> {
  debugLog(`invoke -> ${command}`, payload);
  try {
    const api = await import("@tauri-apps/api/core");
    const result = await api.invoke<TResult>(command, payload);
    debugLog(`invoke <- ${command}`, result);
    return result;
  } catch (error) {
    console.error(`[terminal-debug] invoke error <- ${command}`, error);
    throw new TerminalRuntimeError(getErrorMessage(error, fallbackErrorMessage));
  }
}

export async function isTerminalRuntimeAvailable(): Promise<boolean> {
  try {
    const api = await import("@tauri-apps/api/core");
    const available = typeof api.isTauri === "function" && api.isTauri();
    debugLog(`runtime available=${available}`);
    return available;
  } catch {
    debugLog("runtime unavailable: @tauri-apps/api/core import failed");
    return false;
  }
}

export async function terminalStartSession(input: {
  host: string;
  sshConfigPath?: string;
  shellOverride?: string;
}): Promise<TerminalSessionInfo> {
  const response = await invokeTerminalCommand<RawTerminalSessionInfo>(
    "terminal_start_session",
    {
      host: input.host,
      sshConfigPath: input.sshConfigPath,
      shellOverride: input.shellOverride
    },
    "No fue posible iniciar la sesion de terminal en el backend."
  );
  const normalized = normalizeSessionInfo(response);
  if (!normalized) {
    throw new TerminalRuntimeError("El backend devolvio una sesion de terminal invalida.");
  }
  return normalized;
}

export async function terminalWrite(sessionId: string, data: string): Promise<void> {
  await invokeTerminalCommand<void>(
    "terminal_write",
    {
      sessionId,
      data
    },
    "No fue posible escribir en la sesion de terminal."
  );
}

export async function terminalResize(sessionId: string, cols: number, rows: number): Promise<void> {
  await invokeTerminalCommand<void>(
    "terminal_resize",
    {
      sessionId,
      cols,
      rows
    },
    "No fue posible redimensionar la sesion de terminal."
  );
}

export async function terminalCloseSession(sessionId: string): Promise<void> {
  await invokeTerminalCommand<void>(
    "terminal_close_session",
    {
      sessionId
    },
    "No fue posible cerrar la sesion de terminal."
  );
}

export async function terminalListSshHosts(sshConfigPath?: string): Promise<string[]> {
  const response = await invokeTerminalCommand<unknown>(
    "terminal_list_ssh_hosts",
    {
      sshConfigPath
    },
    "No fue posible listar los hosts SSH."
  );
  if (!Array.isArray(response)) {
    throw new TerminalRuntimeError("El backend devolvio una lista de hosts SSH invalida.");
  }
  return response.filter((entry): entry is string => typeof entry === "string");
}

export async function listenTerminalOutput(
  handler: (event: TerminalOutputEvent) => void
): Promise<() => void> {
  try {
    const eventApi = await import("@tauri-apps/api/event");
    debugLog("listen terminal-output");
    const unlisten = await eventApi.listen<RawTerminalOutputEvent>("terminal-output", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload.session_id !== "string" || typeof payload.data !== "string") {
        debugLog("ignored terminal-output payload", payload);
        return;
      }
      debugLog("terminal-output event", {
        sessionId: payload.session_id,
        bytes: payload.data.length
      });
      handler({
        sessionId: payload.session_id,
        data: payload.data
      });
    });
    return () => {
      debugLog("unlisten terminal-output");
      unlisten();
    };
  } catch (error) {
    console.error("[terminal-debug] listen terminal-output error", error);
    throw new TerminalRuntimeError(
      getErrorMessage(error, "No fue posible suscribirse al stream de salida de terminal.")
    );
  }
}
