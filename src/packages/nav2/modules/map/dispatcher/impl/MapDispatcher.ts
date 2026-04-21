import { Nav2DispatcherBase } from "../../../../protocol/Nav2DispatcherBase";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";

export class MapDispatcher extends Nav2DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId);
  }

  async requestMap(_mapId: string): Promise<Nav2IncomingMessage> {
    return this.request("get_state", {}, { timeoutMs: 6000 });
  }

  async setZonesGeoJson(geojson: unknown): Promise<Nav2IncomingMessage> {
    return this.request("set_zones_geojson", { geojson } as never, { timeoutMs: 6000 });
  }

  async loadZonesFile(): Promise<Nav2IncomingMessage> {
    return this.request("load_zones_file", {}, { timeoutMs: 6000 });
  }

  async getDatums(): Promise<Nav2IncomingMessage> {
    return this.request("get_datums", {}, { timeoutMs: 6000 });
  }

  async saveDatum(datum: Record<string, unknown>): Promise<Nav2IncomingMessage> {
    return this.request("save_datum", { datum } as never, { timeoutMs: 6000 });
  }

  async deleteDatum(id: string): Promise<Nav2IncomingMessage> {
    return this.request("delete_datum", { id } as never, { timeoutMs: 6000 });
  }

  async selectDatum(id: string): Promise<Nav2IncomingMessage> {
    return this.request("select_datum", { id } as never, { timeoutMs: 6000 });
  }

  async captureCurrentGpsDatum(payload: Record<string, unknown>): Promise<Nav2IncomingMessage> {
    return this.request("capture_current_gps_datum", payload as never, { timeoutMs: 6000 });
  }
}
