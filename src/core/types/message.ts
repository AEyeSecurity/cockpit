export type Primitive = string | number | boolean | null;
export type MessagePayload = Primitive | MessagePayload[] | { [key: string]: MessagePayload };

export interface OutgoingPacket {
  op: string;
  requestId?: string;
  clientReqId?: string;
  request?: string;
  payload?: MessagePayload;
  meta?: Record<string, MessagePayload>;
  [key: string]: unknown;
}

export interface IncomingPacket {
  op: string;
  requestId?: string;
  clientReqId?: string;
  request?: string;
  ok?: boolean;
  error?: string;
  payload?: MessagePayload;
  meta?: Record<string, MessagePayload>;
  transportId?: string;
  [key: string]: unknown;
}

export type MessageHandler = (message: IncomingPacket) => void;
