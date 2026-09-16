import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PohodaClient } from "./client.js";
import type { ConnectorConfig } from "./core/config.js";
import type { ConnectorContext } from "./core/context.js";
import type { Principal } from "./core/principal.js";
import { ToolRegistry } from "./core/registry.js";
import type { OutboxService } from "./outbox/service.js";
import type { SqlReader } from "./sql/reader.js";
import { registerSystemTools } from "./tools/system.js";
import { registerAddressTools } from "./tools/addresses.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerOfferTools } from "./tools/offers.js";
import { registerEnquiryTools } from "./tools/enquiries.js";
import { registerContractTools } from "./tools/contracts.js";
import { registerBankTools } from "./tools/bank.js";
import { registerVoucherTools } from "./tools/vouchers.js";
import { registerInternalDocTools } from "./tools/internal_docs.js";
import { registerStockTools } from "./tools/stock.js";
import { registerWarehouseTools } from "./tools/warehouse.js";
import { registerProductionTools } from "./tools/production.js";
import { registerReportTools } from "./tools/reports.js";
import { registerSettingsTools } from "./tools/settings.js";
import { registerProposalTools } from "./tools/proposals.js";
import { registerSqlTools } from "./tools/sql.js";

export interface ServerDeps {
  config: ConnectorConfig;
  client: PohodaClient;
  outbox: OutboxService;
  sql?: SqlReader;
}

export function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(path.resolve(here, "..", "package.json"), "utf-8")) as { version: string };
  return pkg.version;
}

/** Register every tool for one principal. `withMcp=false` builds a REST-only registry. */
export function createRegistry(deps: ServerDeps, principal: Principal, withMcp: boolean): { registry: ToolRegistry; mcp?: McpServer } {
  const ctx: ConnectorContext = { ...deps, principal };
  const mcp = withMcp ? new McpServer({ name: "pohoda-connector", version: packageVersion() }) : undefined;
  const registry = new ToolRegistry(mcp);

  registerSystemTools(registry, ctx);
  registerProposalTools(registry, ctx);
  registerSqlTools(registry, ctx);
  registerAddressTools(registry, ctx);
  registerInvoiceTools(registry, ctx);
  registerBankTools(registry, ctx);
  registerVoucherTools(registry, ctx);
  registerInternalDocTools(registry, ctx);
  registerOrderTools(registry, ctx);
  registerOfferTools(registry, ctx);
  registerEnquiryTools(registry, ctx);
  registerContractTools(registry, ctx);
  registerStockTools(registry, ctx);
  registerWarehouseTools(registry, ctx);
  registerProductionTools(registry, ctx);
  registerReportTools(registry, ctx);
  registerSettingsTools(registry, ctx);

  return { registry, mcp };
}
