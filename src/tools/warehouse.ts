import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { applyFilter } from "../core/filters.js";
import { addDate, addExtId, addPartnerIdentity, addText, hasPartner, money, partnerSchema, vatRateEnum } from "../xml/common.js";

const itemSchema = z.object({
  text: z.string().max(90),
  quantity: z.number().default(1),
  unitPrice: z.number(),
  payVAT: z.boolean().optional(),
  rateVAT: vatRateEnum.optional(),
  unit: z.string().max(10).optional(),
  stockIds: z.string().max(64).optional().describe("Stock card IDS for a stock movement"),
});

const listFilterFields = {
  id: z.number().optional().describe("Document ID"),
  dateFrom: z.string().optional().describe("Date from (DD.MM.YYYY or YYYY-MM-DD)"),
  dateTill: z.string().optional().describe("Date to"),
  lastChanges: z.string().optional().describe("Only changed after this date"),
};

interface WarehouseAgenda {
  listTool: string;
  listDescription: string;
  listTag: string;
  requestTag: string;
  createTool: string;
  createDescription: string;
  agenda: string;
  ns: string;
  prefix: string;
  docTag: string;
}

const AGENDAS: WarehouseAgenda[] = [
  { listTool: "pohoda_list_prijemky", listDescription: "Export receiving documents (příjemky) from POHODA", listTag: "lst:listPrijemkaRequest", requestTag: "lst:requestPrijemka", createTool: "pohoda_create_prijemka", createDescription: "Create a receiving document (příjemka) in POHODA", agenda: "prijemka", ns: NS.pri, prefix: "pri", docTag: "prijemka" },
  { listTool: "pohoda_list_vydejky", listDescription: "Export dispatch documents (výdejky) from POHODA", listTag: "lst:listVydejkaRequest", requestTag: "lst:requestVydejka", createTool: "pohoda_create_vydejka", createDescription: "Create a dispatch document (výdejka) in POHODA", agenda: "vydejka", ns: NS.vyd, prefix: "vyd", docTag: "vydejka" },
  { listTool: "pohoda_list_prodejky", listDescription: "Export sales documents (prodejky) from POHODA", listTag: "lst:listProdejkaRequest", requestTag: "lst:requestProdejka", createTool: "pohoda_create_prodejka", createDescription: "Create a sales document (prodejka) in POHODA", agenda: "prodejka", ns: NS.pro, prefix: "pro", docTag: "prodejka" },
  { listTool: "pohoda_list_prevodky", listDescription: "Export transfer documents (převodky) from POHODA", listTag: "lst:listPrevodkaRequest", requestTag: "lst:requestPrevodka", createTool: "pohoda_create_prevodka", createDescription: "Create a transfer document (převodka) in POHODA", agenda: "prevodka", ns: NS.pre, prefix: "pre", docTag: "prevodka" },
];

export function registerWarehouseTools(host: ToolHost, ctx: ConnectorContext): void {
  for (const a of AGENDAS) {
    host.tool(a.listTool, a.listDescription, listFilterFields, async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, a.listTag, NS.lst, a.requestTag, (req) => applyFilter(req, params));
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult(a.listDescription, data, data.length);
      } catch (e) {
        return err((e as Error).message);
      }
    });

    registerWriteTool(host, ctx, {
      name: a.createTool,
      description: a.createDescription,
      kind: "create",
      agenda: a.agenda,
      schema: {
        date: z.string().describe("Document date (DD.MM.YYYY or YYYY-MM-DD)"),
        text: z.string().max(240).optional().describe("Document text"),
        partner: partnerSchema.optional(),
        note: z.string().optional(),
        items: z.array(itemSchema).optional().describe("Line items"),
      },
      summary: (p) => `${a.docTag} ${p.date} ${p.text ?? ""}`.trim(),
      build: (p, ids, c) =>
        buildImportDoc({ ico: c.client.ico, note: `${a.docTag} ${p.date}` }, ids, (item) => {
          const doc = item.ele(a.ns, `${a.prefix}:${a.docTag}`).att("version", "2.0");
          const hdr = doc.ele(a.ns, `${a.prefix}:${a.docTag}Header`);
          addExtId(hdr, a.ns, a.prefix, ids.extIds, c.config.extSystem);
          addDate(hdr, a.ns, `${a.prefix}:date`, p.date);
          addText(hdr, a.ns, `${a.prefix}:text`, p.text);
          if (hasPartner(p.partner)) addPartnerIdentity(hdr, a.ns, a.prefix, p.partner, c.config.extSystem);
          addText(hdr, a.ns, `${a.prefix}:note`, p.note);
          if (p.items?.length) {
            const det = doc.ele(a.ns, `${a.prefix}:${a.docTag}Detail`);
            for (const i of p.items) {
              const li = det.ele(a.ns, `${a.prefix}:${a.docTag}Item`);
              li.ele(a.ns, `${a.prefix}:text`).txt(i.text);
              li.ele(a.ns, `${a.prefix}:quantity`).txt(String(i.quantity));
              if (i.unit) li.ele(a.ns, `${a.prefix}:unit`).txt(i.unit);
              if (i.payVAT != null) li.ele(a.ns, `${a.prefix}:payVAT`).txt(i.payVAT ? "true" : "false");
              if (i.rateVAT) li.ele(a.ns, `${a.prefix}:rateVAT`).txt(i.rateVAT);
              li.ele(a.ns, `${a.prefix}:homeCurrency`).ele(NS.typ, "typ:unitPrice").txt(money(i.unitPrice));
              if (i.stockIds) li.ele(a.ns, `${a.prefix}:stockItem`).ele(NS.typ, "typ:stockItem").ele(NS.typ, "typ:ids").txt(i.stockIds);
            }
          }
        }),
    });
  }
}
