#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PohodaClient } from "./client.js";
import { loadConfig } from "./core/config.js";
import { startHttpServer } from "./http/server.js";
import { MssqlOutboxStore } from "./outbox/mssql_store.js";
import { OutboxService } from "./outbox/service.js";
import { SqliteOutboxStore } from "./outbox/sqlite_store.js";
import type { OutboxStore } from "./outbox/store.js";
import { createRegistry, packageVersion, type ServerDeps } from "./server.js";
import { loadDictionary } from "./sql/dictionary.js";
import { SqlReader } from "./sql/reader.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new PohodaClient({ ...config.pohoda, checkDuplicity: true });

  const store: OutboxStore = config.store.kind === "mssql" ? new MssqlOutboxStore(config.store.mssql!) : new SqliteOutboxStore(config.store.sqlitePath);
  await store.init();
  const outbox = new OutboxService(store, config, client);

  let sql: SqlReader | undefined;
  if (config.sql) {
    sql = new SqlReader(config.sql, loadDictionary());
    await sql.connect();
  }

  const deps: ServerDeps = { config, client, outbox, sql };

  if (config.transport === "http") {
    const { port } = await startHttpServer(deps);
    console.error(`pohoda-connector ${packageVersion()} listening on http://${config.http.host}:${port} (mode=${config.writeMode}, sandbox=${config.sandbox}, sql=${sql ? "on" : "off"})`);
    return;
  }

  const { mcp } = createRegistry(deps, config.stdioPrincipal, true);
  await mcp!.connect(new StdioServerTransport());
  console.error(`pohoda-connector ${packageVersion()} on stdio as ${config.stdioPrincipal.role}:${config.stdioPrincipal.name} (mode=${config.writeMode})`);
}

main().catch((e) => {
  console.error("pohoda-connector failed to start:", (e as Error).message);
  process.exit(1);
});
