import type { PohodaClient } from "../client.js";
import type { OutboxService } from "../outbox/service.js";
import type { SqlReader } from "../sql/reader.js";
import type { ConnectorConfig } from "./config.js";
import type { Principal } from "./principal.js";

/** Everything a tool handler may touch. One instance per principal (per session on HTTP). */
export interface ConnectorContext {
  config: ConnectorConfig;
  client: PohodaClient;
  outbox: OutboxService;
  principal: Principal;
  sql?: SqlReader;
}
