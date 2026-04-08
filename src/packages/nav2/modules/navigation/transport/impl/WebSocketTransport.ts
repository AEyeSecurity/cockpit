import type {
  Transport,
  TransportContext,
  TransportReceiveHandler,
  TransportStatus,
  TransportStatusHandler
} from "../../../../../core/modules/runtime/transport/base/Transport";
import { decodeNav2Incoming, encodeNav2Outgoing, toNav2OutgoingMessage } from "../../../../protocol/messages";

export class WebSocketTransport implements Transport {
  readonly kind = "websocket";
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<TransportReceiveHandler>();
  private readonly statusHandlers = new Set<TransportStatusHandler>();
  private connectedUrl = "";
  private disconnectRequested = false;

  constructor(readonly id: string, private readonly urlResolver: (ctx: TransportContext) => string) {}

  async connect(ctx: TransportContext): Promise<void> {
    const url = this.urlResolver(ctx);
    this.connectedUrl = url;
    this.disconnectRequested = false;
    if (typeof WebSocket === "undefined") return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => {
        this.emitStatus({
          connected: true,
          intentional: false,
          reason: ""
        });
        resolve();
      };
      socket.onerror = () => reject(new Error(`WebSocket connection failed: ${url}`));
      socket.onclose = (event) => {
        const intentional = this.disconnectRequested;
        if (this.ws === socket) {
          this.ws = null;
        }
        this.disconnectRequested = false;
        this.emitStatus({
          connected: false,
          intentional,
          reason: intentional ? "" : this.buildCloseReason(event)
        });
      };
      socket.onmessage = (event) => {
        try {
          const parsed = decodeNav2Incoming(JSON.parse(String(event.data)));
          if (!parsed) return;
          this.handlers.forEach((handler) => handler(parsed));
        } catch {
          // Ignore malformed payloads.
        }
      };
      this.ws = socket;
    });
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    this.disconnectRequested = true;
    this.ws.close();
    this.ws = null;
  }

  async send(packet: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket transport '${this.id}' is disconnected (${this.connectedUrl || "unknown url"})`);
    }
    const outgoing = toNav2OutgoingMessage(packet);
    this.ws.send(JSON.stringify(encodeNav2Outgoing(outgoing)));
  }

  recv(handler: TransportReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeStatus(handler: TransportStatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(status: TransportStatus): void {
    this.statusHandlers.forEach((handler) => handler(status));
  }

  private buildCloseReason(event: CloseEvent): string {
    const reason = String(event.reason ?? "").trim();
    if (reason) return reason;
    if (Number.isFinite(event.code) && event.code !== 1000) {
      return `WebSocket closed with code ${event.code}`;
    }
    return `WebSocket connection lost: ${this.connectedUrl || this.id}`;
  }
}
