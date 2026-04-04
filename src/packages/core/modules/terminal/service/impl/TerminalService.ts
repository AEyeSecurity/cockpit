import {
  isTerminalRuntimeAvailable,
  listenTerminalOutput,
  terminalCloseSession,
  terminalListSshHosts,
  terminalResize,
  terminalStartSession,
  terminalWrite,
  type TerminalOutputEvent
} from "../../../../../../platform/tauri/terminal";

interface TerminalSessionEntry {
  id: string;
  host: string;
  local: boolean;
}

export interface TerminalSessionView {
  id: string;
  host: string;
  local: boolean;
  label: string;
}

export interface TerminalState {
  supported: boolean;
  loadingHosts: boolean;
  creatingSession: boolean;
  sshConfigPath: string;
  defaultHost: string;
  selectedHost: string;
  hosts: string[];
  sessions: TerminalSessionView[];
  activeSessionId: string | null;
  lastError: string;
}

export interface TerminalServiceOptions {
  sshConfigPath: string;
  defaultHost: string;
  shellOverride: string;
  scrollback: number;
}

type TerminalStateListener = (state: TerminalState) => void;
type TerminalOutputListener = (event: TerminalOutputEvent) => void;

function normalizeHostName(value: string): string {
  const next = value.trim();
  return next.length > 0 ? next : "Localhost";
}

function uniqueHostList(hosts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawHost of hosts) {
    const host = normalizeHostName(rawHost);
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(host);
  }
  return result;
}

function buildSessionViews(entries: TerminalSessionEntry[]): TerminalSessionView[] {
  const totalsByHost = new Map<string, number>();
  entries.forEach((entry) => {
    const key = entry.host.toLowerCase();
    totalsByHost.set(key, (totalsByHost.get(key) ?? 0) + 1);
  });

  const indexByHost = new Map<string, number>();
  return entries.map((entry) => {
    const key = entry.host.toLowerCase();
    const total = totalsByHost.get(key) ?? 1;
    const nextIndex = (indexByHost.get(key) ?? 0) + 1;
    indexByHost.set(key, nextIndex);
    return {
      id: entry.id,
      host: entry.host,
      local: entry.local,
      label: total > 1 ? `${entry.host} (${nextIndex})` : entry.host
    };
  });
}

function errorDetails(error: unknown): string {
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message.length > 0) {
      return message;
    }
  }
  return "Error desconocido.";
}

function withErrorDetails(prefix: string, error: unknown): string {
  return `${prefix}: ${errorDetails(error)}`;
}

function logDebug(message: string, details?: unknown): void {
  if (details === undefined) {
    console.debug(`[terminal-debug] ${message}`);
    return;
  }
  console.debug(`[terminal-debug] ${message}`, details);
}

export class TerminalService {
  private readonly stateListeners = new Set<TerminalStateListener>();
  private readonly outputListeners = new Set<TerminalOutputListener>();
  private readonly sessionBuffers = new Map<string, string>();
  private readonly maxBufferChars: number;
  private shellOverride: string;
  private unlistenOutput: (() => void) | null = null;
  private state: TerminalState;
  private sessions: TerminalSessionEntry[] = [];

  constructor(options: TerminalServiceOptions) {
    const defaultHost = normalizeHostName(options.defaultHost);
    this.shellOverride = options.shellOverride.trim();
    this.maxBufferChars = Math.max(2_000, Math.floor(options.scrollback * 180));
    this.state = {
      supported: false,
      loadingHosts: true,
      creatingSession: false,
      sshConfigPath: options.sshConfigPath.trim() || "~/.ssh/config",
      defaultHost,
      selectedHost: defaultHost,
      hosts: uniqueHostList([defaultHost, "Localhost"]),
      sessions: [],
      activeSessionId: null,
      lastError: ""
    };
    void this.bootstrap();
  }

  getState(): TerminalState {
    return {
      ...this.state,
      hosts: [...this.state.hosts],
      sessions: [...this.state.sessions]
    };
  }

  subscribe(listener: TerminalStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeOutput(listener: TerminalOutputListener): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  getScrollback(): number {
    return Math.max(200, Math.floor(this.maxBufferChars / 180));
  }

  getSessionBuffer(sessionId: string): string {
    return this.sessionBuffers.get(sessionId) ?? "";
  }

  setSelectedHost(host: string): void {
    const normalized = normalizeHostName(host);
    if (this.state.selectedHost === normalized) return;
    this.state = {
      ...this.state,
      selectedHost: normalized
    };
    this.emitState();
  }

  async refreshHosts(): Promise<void> {
    if (!this.state.supported) {
      this.state = {
        ...this.state,
        loadingHosts: false
      };
      this.emitState();
      return;
    }

    this.state = {
      ...this.state,
      loadingHosts: true,
      lastError: ""
    };
    this.emitState();

    let discovered: string[];
    try {
      discovered = await terminalListSshHosts(this.state.sshConfigPath);
      logDebug("refreshHosts success", { count: discovered.length, hosts: discovered });
    } catch (error) {
      console.error("[terminal-debug] refreshHosts error", error);
      this.state = {
        ...this.state,
        loadingHosts: false,
        lastError: withErrorDetails("No fue posible leer hosts SSH en el runtime actual", error)
      };
      this.emitState();
      return;
    }

    const hosts = uniqueHostList([this.state.defaultHost, "Localhost", ...discovered]);
    const selectedHost = hosts.includes(this.state.selectedHost) ? this.state.selectedHost : hosts[0] ?? "Localhost";
    this.state = {
      ...this.state,
      loadingHosts: false,
      hosts,
      selectedHost,
      lastError: ""
    };
    this.emitState();
  }

  async openSession(host?: string): Promise<void> {
    const targetHost = normalizeHostName(host ?? this.state.selectedHost ?? this.state.defaultHost);
    logDebug("openSession", {
      targetHost,
      sshConfigPath: this.state.sshConfigPath,
      shellOverride: this.shellOverride
    });
    if (!this.state.supported) {
      this.state = {
        ...this.state,
        lastError: "Terminal disponible solo en desktop."
      };
      this.emitState();
      return;
    }

    this.state = {
      ...this.state,
      creatingSession: true,
      lastError: ""
    };
    this.emitState();

    let sessionInfo;
    try {
      sessionInfo = await terminalStartSession({
        host: targetHost,
        sshConfigPath: this.state.sshConfigPath,
        shellOverride: this.shellOverride
      });
      logDebug("openSession started", sessionInfo);
    } catch (error) {
      console.error("[terminal-debug] openSession error", error);
      this.state = {
        ...this.state,
        creatingSession: false,
        lastError: withErrorDetails("No fue posible iniciar la sesion de terminal", error)
      };
      this.emitState();
      return;
    }

    this.sessions.push({
      id: sessionInfo.sessionId,
      host: sessionInfo.host,
      local: sessionInfo.local
    });
    this.sessionBuffers.set(sessionInfo.sessionId, "");
    this.state = {
      ...this.state,
      creatingSession: false,
      hosts: uniqueHostList([...this.state.hosts, sessionInfo.host]),
      selectedHost: sessionInfo.host,
      activeSessionId: sessionInfo.sessionId,
      sessions: buildSessionViews(this.sessions),
      lastError: ""
    };
    this.emitState();
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (this.state.supported) {
      try {
        logDebug("closeSession", { sessionId });
        await terminalCloseSession(sessionId);
      } catch (error) {
        console.error("[terminal-debug] closeSession error", error);
        this.state = {
          ...this.state,
          lastError: withErrorDetails("No fue posible cerrar la sesion de terminal", error)
        };
        this.emitState();
        return;
      }
    }

    const beforeLength = this.sessions.length;
    this.sessions = this.sessions.filter((entry) => entry.id !== sessionId);
    if (this.sessions.length === beforeLength) return;
    this.sessionBuffers.delete(sessionId);
    const nextActive =
      this.state.activeSessionId === sessionId ? this.sessions[this.sessions.length - 1]?.id ?? null : this.state.activeSessionId;
    this.state = {
      ...this.state,
      activeSessionId: nextActive,
      sessions: buildSessionViews(this.sessions),
      lastError: ""
    };
    this.emitState();
  }

  setActiveSession(sessionId: string): void {
    if (!this.sessions.some((entry) => entry.id === sessionId)) return;
    if (this.state.activeSessionId === sessionId) return;
    this.state = {
      ...this.state,
      activeSessionId: sessionId
    };
    this.emitState();
  }

  async writeToActive(data: string): Promise<void> {
    if (!this.state.supported) return;
    const sessionId = this.state.activeSessionId;
    if (!sessionId) return;
    try {
      logDebug("writeToActive", { sessionId, bytes: data.length });
      await terminalWrite(sessionId, data);
      if (this.state.lastError) {
        this.state = {
          ...this.state,
          lastError: ""
        };
        this.emitState();
      }
    } catch (error) {
      console.error("[terminal-debug] writeToActive error", error);
      this.state = {
        ...this.state,
        lastError: withErrorDetails("No fue posible escribir en la sesion de terminal", error)
      };
      this.emitState();
    }
  }

  async resizeActive(cols: number, rows: number): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) return;
    await this.resizeSession(sessionId, cols, rows);
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    if (!this.state.supported) return;
    if (!sessionId) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const nextCols = Math.max(2, Math.floor(cols));
    const nextRows = Math.max(2, Math.floor(rows));
    try {
      logDebug("resizeSession", { sessionId, cols: nextCols, rows: nextRows });
      await terminalResize(sessionId, nextCols, nextRows);
      if (this.state.lastError) {
        this.state = {
          ...this.state,
          lastError: ""
        };
        this.emitState();
      }
    } catch (error) {
      console.error("[terminal-debug] resizeSession error", error);
      this.state = {
        ...this.state,
        lastError: withErrorDetails("No fue posible redimensionar la sesion de terminal", error)
      };
      this.emitState();
    }
  }

  async dispose(): Promise<void> {
    this.unlistenOutput?.();
    this.unlistenOutput = null;
    const sessionIds = this.sessions.map((entry) => entry.id);
    this.sessions = [];
    this.sessionBuffers.clear();
    this.state = {
      ...this.state,
      sessions: [],
      activeSessionId: null
    };
    this.emitState();
    if (!this.state.supported) return;
    const results = await Promise.allSettled(sessionIds.map((sessionId) => terminalCloseSession(sessionId)));
    const firstFailure = results.find((result) => result.status === "rejected");
    if (firstFailure) {
      this.state = {
        ...this.state,
        lastError: withErrorDetails("No fue posible cerrar todas las sesiones de terminal", firstFailure.reason)
      };
      this.emitState();
    }
  }

  applyRuntimeConfig(input: { sshConfigPath?: string; defaultHost?: string; shellOverride?: string }): void {
    const nextDefaultHost = normalizeHostName(input.defaultHost ?? this.state.defaultHost);
    const nextSshConfigPath = (input.sshConfigPath ?? this.state.sshConfigPath).trim() || "~/.ssh/config";
    const nextShellOverride = (input.shellOverride ?? this.shellOverride).trim();
    const changed =
      nextDefaultHost !== this.state.defaultHost ||
      nextSshConfigPath !== this.state.sshConfigPath ||
      nextShellOverride !== this.shellOverride;
    if (!changed) return;

    this.state = {
      ...this.state,
      defaultHost: nextDefaultHost,
      sshConfigPath: nextSshConfigPath,
      hosts: uniqueHostList([nextDefaultHost, ...this.state.hosts]),
      selectedHost:
        this.state.selectedHost.trim().length > 0
          ? this.state.selectedHost
          : nextDefaultHost
    };
    this.emitState();
    this.shellOverride = nextShellOverride;
    void this.refreshHosts();
  }

  private emitState(): void {
    const snapshot = this.getState();
    this.stateListeners.forEach((listener) => listener(snapshot));
  }

  private emitOutput(event: TerminalOutputEvent): void {
    this.outputListeners.forEach((listener) => listener(event));
  }

  private pushOutput(sessionId: string, chunk: string): void {
    const previous = this.sessionBuffers.get(sessionId) ?? "";
    const combined = previous + chunk;
    const nextValue =
      combined.length > this.maxBufferChars ? combined.slice(combined.length - this.maxBufferChars) : combined;
    this.sessionBuffers.set(sessionId, nextValue);
  }

  private async bootstrap(): Promise<void> {
    const supported = await isTerminalRuntimeAvailable();
    logDebug("bootstrap", { supported });
    this.state = {
      ...this.state,
      supported,
      loadingHosts: supported
    };
    this.emitState();
    if (!supported) {
      this.state = {
        ...this.state,
        loadingHosts: false
      };
      this.emitState();
      return;
    }

    try {
      this.unlistenOutput = await listenTerminalOutput((event) => {
        logDebug("output event", { sessionId: event.sessionId, bytes: event.data.length });
        this.pushOutput(event.sessionId, event.data);
        this.emitOutput(event);
      });
    } catch (error) {
      console.error("[terminal-debug] bootstrap output listener error", error);
      this.state = {
        ...this.state,
        loadingHosts: false,
        lastError: withErrorDetails("No fue posible iniciar el stream de salida de terminal", error)
      };
      this.emitState();
      return;
    }
    await this.refreshHosts();
  }
}
