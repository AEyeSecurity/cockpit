export type WebZoneMessage = Record<string, unknown> & {
  op?: string;
  ok?: boolean;
  error?: string | null;
  request?: string;
  client_req_id?: string;
};

export type WebZoneStatus = {
  connected: boolean;
  connecting: boolean;
  url: string;
  error: string;
};

export type WebZoneClient = {
  /** (Re)conecta a una URL `ws://host:port`. Reintenta solo mientras no se desconecte a mano. */
  connect(url: string): void;
  /** Cierra y deja de reintentar (desconexión manual del operador). */
  disconnect(): void;
  send(op: string, payload?: Record<string, unknown>): void;
  close(): void;
};

type ClientOptions = {
  onMessage: (message: WebZoneMessage) => void;
  onStatus: (status: WebZoneStatus) => void;
};

const reconnectDelayMs = 1800;

export function resolveWebZoneUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL;
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim();
  }

  const { host, port } = realBackendDefault();
  return `ws://${host}:${port}`;
}

export function realBackendDefault(): { host: string; port: string } {
  const port = String(import.meta.env.VITE_WS_DEFAULT_PORT || '8766');
  const host = String(import.meta.env.VITE_WS_REAL_HOST || window.location.hostname || 'localhost');
  return { host, port };
}

export function createWebZoneClient(options: ClientOptions): WebZoneClient {
  let url = resolveWebZoneUrl();
  let socket: WebSocket | null = null;
  let manualDisconnect = true; // arranca sin conectar; el hook llama connect()
  let reconnectTimer: number | null = null;
  let sequence = 0;

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (manualDisconnect || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      open();
    }, reconnectDelayMs);
  }

  function send(op: string, payload: Record<string, unknown> = {}): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    sequence += 1;
    const requestId = `cockpit_simple.${op}.${Date.now()}.${sequence}`;
    socket.send(
      JSON.stringify({
        ...payload,
        op,
        requestId,
        client_req_id: requestId,
      }),
    );
  }

  function closeSocket(): void {
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // ignorar
    }
    socket = null;
  }

  function open(): void {
    if (manualDisconnect || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    options.onStatus({ connected: false, connecting: true, url, error: '' });
    socket = new WebSocket(url);

    socket.onopen = () => {
      options.onStatus({ connected: true, connecting: false, url, error: '' });
      // Mismo handshake que el cockpit original: libera el lock y pide el estado.
      send('set_control_lock', { locked: false });
      send('get_state');
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data));
        if (parsed && typeof parsed === 'object') {
          options.onMessage(parsed as WebZoneMessage);
        }
      } catch {
        // El gateway puede seguir operando aunque llegue un mensaje malformado.
      }
    };

    socket.onerror = () => {
      options.onStatus({ connected: false, connecting: false, url, error: 'Could not reach backend' });
    };

    socket.onclose = (event) => {
      socket = null;
      const reason = typeof event.reason === 'string' && event.reason.trim() ? event.reason.trim() : '';
      options.onStatus({
        connected: false,
        connecting: !manualDisconnect,
        url,
        error: manualDisconnect ? '' : reason || `Backend disconnected (${event.code || 'no code'})`,
      });
      scheduleReconnect();
    };
  }

  const heartbeat = window.setInterval(() => {
    send('control_heartbeat');
  }, 1000);

  return {
    connect(nextUrl: string) {
      url = nextUrl.trim() || url;
      manualDisconnect = false;
      clearReconnect();
      closeSocket();
      open();
    },
    disconnect() {
      manualDisconnect = true;
      clearReconnect();
      closeSocket();
      options.onStatus({ connected: false, connecting: false, url, error: '' });
    },
    send,
    close() {
      manualDisconnect = true;
      clearReconnect();
      window.clearInterval(heartbeat);
      closeSocket();
    },
  };
}
