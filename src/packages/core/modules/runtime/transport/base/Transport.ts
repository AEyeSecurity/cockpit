import type { EnvConfig } from "../../../../../../core/config/envConfig";
import type { IncomingPacket, OutgoingPacket } from "../../../../../../core/types/message";

// TODO: eliminar esta interfaz. hacer que cada clase que implemente Transport simplemente defina connect(), sin argumentos
// TODO: las variables de entorno se gestionarán por paquete, entonces se debe crear una clase EnvManager en el paquete core
// servirá como plantilla para los demás paquetes para que puedan gestionar independientemente sus envs
// atributos: envFile, isloaded (para singleton), variables: Map<string, string>
// funciones: 
//    get: (string) => string. implementa patron singleton para que la primera vez que se llame carge las variables desde el archivo

export interface TransportContext {
  env: EnvConfig;
}

// TODO: usar clase generica en lugar de IncomingPacket/OutgoingPackage
export type TransportReceiveHandler = (message: IncomingPacket) => void;

export interface Transport {
  id: string;
  kind: string;
  connect(ctx: TransportContext): Promise<void>;
  disconnect(): Promise<void>;
  send(packet: OutgoingPacket): Promise<void>;
  recv(handler: TransportReceiveHandler): () => void;
}

