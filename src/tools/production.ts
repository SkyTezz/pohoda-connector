import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { applyFilter } from "../core/filters.js";
import { addDate, addText, money } from "../xml/common.js";

export function registerProductionTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_vyroba",
    "Export production documents (výroba) from POHODA",
    {
      id: z.number().optional().describe("Document ID"),
      dateFrom: z.string().optional().describe("Date from"),
      dateTill: z.string().optional().describe("Date to"),
      lastChanges: z.string().optional().describe("Only changed after this date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listVyrobaRequest", NS.lst, "lst:requestVyroba", (req) => applyFilter(req, params));
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Production documents", data, data.length);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_vyroba",
    description: "Create a production document (výroba) in POHODA",
    kind: "create",
    agenda: "vyroba",
    schema: {
      date: z.string().describe("Document date (DD.MM.YYYY or YYYY-MM-DD)"),
      text: z.string().max(240).optional().describe("Description"),
      note: z.string().optional(),
      items: z
        .array(
          z.object({
            text: z.string().max(90),
            quantity: z.number().default(1),
            unitPrice: z.number(),
            unit: z.string().max(10).optional(),
            stockIds: z.string().max(64).optional(),
          }),
        )
        .optional()
        .describe("Production items"),
    },
    summary: (p) => `vyroba ${p.date} ${p.text ?? ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `vyroba ${p.date}` }, ids, (item) => {
        const doc = item.ele(NS.vyr, "vyr:vyroba").att("version", "2.0");
        const hdr = doc.ele(NS.vyr, "vyr:vyrobaHeader");
        addDate(hdr, NS.vyr, "vyr:date", p.date);
        addText(hdr, NS.vyr, "vyr:text", p.text);
        addText(hdr, NS.vyr, "vyr:note", p.note);
        if (p.items?.length) {
          const det = doc.ele(NS.vyr, "vyr:vyrobaDetail");
          for (const i of p.items) {
            const li = det.ele(NS.vyr, "vyr:vyrobaItem");
            li.ele(NS.vyr, "vyr:text").txt(i.text);
            li.ele(NS.vyr, "vyr:quantity").txt(String(i.quantity));
            if (i.unit) li.ele(NS.vyr, "vyr:unit").txt(i.unit);
            li.ele(NS.vyr, "vyr:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(i.unitPrice));
            if (i.stockIds) li.ele(NS.vyr, "vyr:stockItem").ele(NS.typ, "typ:stockItem").ele(NS.typ, "typ:ids").txt(i.stockIds);
          }
        }
      }),
  });

  host.tool(
    "pohoda_list_service",
    "Export service records from POHODA",
    {
      id: z.number().optional().describe("Service record ID"),
      dateFrom: z.string().optional().describe("Date from"),
      dateTill: z.string().optional().describe("Date to"),
      lastChanges: z.string().optional().describe("Only changed after this date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listServiceRequest", NS.lst, "lst:requestService", (req) => applyFilter(req, params));
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Service records", data, data.length);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_service",
    description: "Create a service record in POHODA",
    kind: "create",
    agenda: "service",
    schema: {
      date: z.string().describe("Service date"),
      text: z.string().max(240).optional().describe("Description"),
      partnerName: z.string().max(32).optional(),
      note: z.string().optional(),
    },
    summary: (p) => `service ${p.date} ${p.text ?? ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `service ${p.date}` }, ids, (item) => {
        const doc = item.ele(NS.ser, "ser:service").att("version", "2.0");
        const hdr = doc.ele(NS.ser, "ser:serviceHeader");
        addDate(hdr, NS.ser, "ser:date", p.date);
        addText(hdr, NS.ser, "ser:text", p.text);
        if (p.partnerName) hdr.ele(NS.ser, "ser:partnerIdentity").ele(NS.typ, "typ:address").ele(NS.typ, "typ:name").txt(p.partnerName);
        addText(hdr, NS.ser, "ser:note", p.note);
      }),
  });
}
