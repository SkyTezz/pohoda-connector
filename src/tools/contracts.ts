import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { applyFilter, type ListFilterParams } from "../core/filters.js";
import { addDate, addPartnerIdentity, addText, hasPartner, partnerSchema } from "../xml/common.js";

export function registerContractTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_contracts",
    "List contracts (zakázky) from POHODA. Supports filtering by ID, date range, company name, or last changes. Returns JSON array of matching contract records.",
    {
      id: z.number().optional().describe("Filter by contract ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      companyName: z.string().optional().describe("Filter by company name"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listContractRequest", NS.lCon, "lst:requestContract", (req) => {
          const filterParams: ListFilterParams = { id: params.id, dateFrom: params.dateFrom, dateTill: params.dateTill, companyName: params.companyName, lastChanges: params.lastChanges };
          applyFilter(req, filterParams);
        });
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Contracts", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_contract",
    description: "Create a contract (zakázka) in POHODA. Optional: number, datePlan, text, partner, note.",
    kind: "create",
    agenda: "contract",
    schema: {
      number: z.string().max(32).optional().describe("Contract number"),
      datePlan: z.string().optional().describe("Planned date (DD.MM.YYYY or YYYY-MM-DD)"),
      text: z.string().max(240).optional(),
      partner: partnerSchema.optional(),
      note: z.string().optional(),
    },
    summary: (p) => `contract ${p.number ?? ""} ${p.text ?? ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `contract ${p.number ?? ""}`.trim() }, ids, (item) => {
        const con = item.ele(NS.con, "con:contract").att("version", "2.0");
        const desc = con.ele(NS.con, "con:contractDesc");
        addText(desc, NS.con, "con:number", p.number);
        addDate(desc, NS.con, "con:datePlan", p.datePlan);
        addText(desc, NS.con, "con:text", p.text);
        if (hasPartner(p.partner)) addPartnerIdentity(desc, NS.con, "con", p.partner, c.config.extSystem);
        addText(desc, NS.con, "con:note", p.note);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_delete_contract",
    description: "Delete a contract from POHODA by ID. Disabled unless CONNECTOR_ALLOW_DELETE=true.",
    kind: "delete",
    agenda: "contract",
    schema: { id: z.number().describe("Contract ID to delete (required)") },
    summary: (p) => `delete contract id ${p.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `delete contract ${p.id}` }, ids, (item) => {
        const con = item.ele(NS.con, "con:contract").att("version", "2.0");
        con.ele(NS.con, "con:actionType").ele(NS.con, "con:delete").ele(NS.ftr, "ftr:filter").ele(NS.ftr, "ftr:id").txt(String(p.id));
      }),
  });
}
