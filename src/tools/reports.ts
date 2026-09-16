import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { buildExportRequest } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult, type ToolResult } from "../core/types.js";
import { applyFilter, type ListFilterParams } from "../core/filters.js";

const dateRange = {
  dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
  dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
};

export function registerReportTools(host: ToolHost, ctx: ConnectorContext): void {
  const run = async (label: string, listTag: string, requestTag: string, params: ListFilterParams): Promise<ToolResult> => {
    try {
      const xml = buildExportRequest({ ico: ctx.client.ico }, listTag, NS.lst, requestTag, (req) => applyFilter(req, params));
      const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
      return jsonResult(label, data, Array.isArray(data) ? data.length : 0);
    } catch (e) {
      return err((e as Error).message);
    }
  };

  host.tool(
    "pohoda_list_accountancy",
    "List accounting journal records (účetní deník) from POHODA via XML export. Read-only. Filter by date range or last changes.",
    { ...dateRange, lastChanges: z.string().optional().describe("Filter by last changes date") },
    (params) => run("Accountancy", "lst:listAccountancyRequest", "lst:requestAccountancy", params),
  );
  host.tool("pohoda_list_balance", "List balance (saldo) records from POHODA. Read-only. Filter by date range.", dateRange, (params) =>
    run("Balance", "lst:listBalanceRequest", "lst:requestBalance", params),
  );
  host.tool("pohoda_list_movements", "List stock movement records from POHODA. Read-only. Filter by date range.", dateRange, (params) =>
    run("Movements", "lst:listMovementRequest", "lst:requestMovement", params),
  );
  host.tool("pohoda_list_vat", "List VAT classification records (členění DPH) from POHODA. Read-only.", dateRange, (params) =>
    run("VAT classification", "lst:listClassificationVATRequest", "lst:requestClassificationVAT", params),
  );
}
