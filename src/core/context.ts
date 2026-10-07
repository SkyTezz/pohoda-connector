import type { MServer } from "../client.js";
import type { OutboxService } from "../outbox/service.js";
import type { SqlReader } from "../sql/reader.js";
import type { ConnectorConfig } from "./config.js";
import type { Principal } from "./principal.js";
import type { Units } from "./units.js";

/** Everything a tool handler may touch. One instance per principal (per session on HTTP). */
export interface ConnectorContext {
  config: ConnectorConfig;
  /** mServer of the accounting unit the current call is for (`Units.routed`). */
  client: MServer;
  units: Units;
  outbox: OutboxService;
  principal: Principal;
  sql?: SqlReader;
}
