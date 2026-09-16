import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc, type XMLBuilder } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import type { ListFilterParams } from "../core/filters.js";
import { toIsoDate } from "../core/shared.js";
import { addDate, addExtId, addPartnerIdentity, addText, hasPartner, money, partnerSchema, vatRateEnum } from "../xml/common.js";

const orderTypeEnum = z.enum(["issuedOrder", "receivedOrder"]);

const orderItemSchema = z.object({
  text: z.string().max(90),
  quantity: z.number().default(1),
  unitPrice: z.number(),
  payVAT: z.boolean().optional(),
  rateVAT: vatRateEnum.default("none"),
  unit: z.string().max(10).optional(),
  code: z.string().max(64).optional(),
  stockIds: z.string().max(64).optional(),
});

function applyOrderFilter(parent: XMLBuilder, params: ListFilterParams & { numberOrder?: string }): void {
  const hasAny = Object.values(params).some((v) => v != null && v !== "");
  if (!hasAny) return;

  const ftr = parent.ele(NS.ftr, "ftr:filter");
  if (params.id != null) ftr.ele(NS.ftr, "ftr:id").txt(String(params.id));
  if (params.dateFrom) ftr.ele(NS.ftr, "ftr:dateFrom").txt(toIsoDate(params.dateFrom));
  if (params.dateTill) ftr.ele(NS.ftr, "ftr:dateTill").txt(toIsoDate(params.dateTill));
  if (params.companyName) ftr.ele(NS.ftr, "ftr:selectedCompany").txt(params.companyName);
  if (params.numberOrder) ftr.ele(NS.ftr, "ftr:selectedNumberOrder").txt(params.numberOrder);
  if (params.lastChanges) ftr.ele(NS.ftr, "ftr:lastChanges").txt(toIsoDate(params.lastChanges));
}

export function registerOrderTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_orders",
    "List orders from POHODA. Supports filtering by order type, ID, date range, company name, order number, or last changes. Returns JSON array of matching order records.",
    {
      orderType: orderTypeEnum.optional().describe("Filter by order type (issuedOrder or receivedOrder)"),
      id: z.number().optional().describe("Filter by order ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      companyName: z.string().optional().describe("Filter by company name"),
      numberOrder: z.string().optional().describe("Filter by order number"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listOrderRequest", NS.lst, "lst:requestOrder", (req) => {
          if (params.orderType) req.att("orderType", params.orderType);
          applyOrderFilter(req, { id: params.id, dateFrom: params.dateFrom, dateTill: params.dateTill, companyName: params.companyName, numberOrder: params.numberOrder, lastChanges: params.lastChanges });
        });
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Orders", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_order",
    description: "Create an order (issued or received) in POHODA with partner and line items.",
    kind: "create",
    agenda: "order",
    schema: {
      orderType: orderTypeEnum.describe("issuedOrder = vydaná, receivedOrder = přijatá"),
      date: z.string().describe("Order date (DD.MM.YYYY or YYYY-MM-DD)"),
      numberOrder: z.string().max(32).optional().describe("Order number"),
      text: z.string().max(240).optional(),
      partner: partnerSchema.optional(),
      note: z.string().optional(),
      items: z.array(orderItemSchema).optional(),
    },
    summary: (p) => `${p.orderType} ${p.numberOrder ?? ""} ${p.date}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `${p.orderType} ${p.numberOrder ?? ""}`.trim() }, ids, (item) => {
        const ord = item.ele(NS.ord, "ord:order").att("version", "2.0");
        const header = ord.ele(NS.ord, "ord:orderHeader");
        addExtId(header, NS.ord, "ord", ids.extIds, c.config.extSystem);
        header.ele(NS.ord, "ord:orderType").txt(p.orderType);
        addDate(header, NS.ord, "ord:date", p.date);
        addText(header, NS.ord, "ord:numberOrder", p.numberOrder);
        addText(header, NS.ord, "ord:text", p.text);
        if (hasPartner(p.partner)) addPartnerIdentity(header, NS.ord, "ord", p.partner, c.config.extSystem);
        addText(header, NS.ord, "ord:note", p.note);
        if (p.items?.length) {
          const detail = ord.ele(NS.ord, "ord:orderDetail");
          for (const it of p.items) {
            const el = detail.ele(NS.ord, "ord:orderItem");
            el.ele(NS.ord, "ord:text").txt(it.text);
            el.ele(NS.ord, "ord:quantity").txt(String(it.quantity));
            if (it.unit) el.ele(NS.ord, "ord:unit").txt(it.unit);
            el.ele(NS.ord, "ord:payVAT").txt(it.payVAT ? "true" : "false");
            el.ele(NS.ord, "ord:rateVAT").txt(it.rateVAT);
            el.ele(NS.ord, "ord:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(it.unitPrice));
            if (it.code) el.ele(NS.ord, "ord:code").txt(it.code);
            if (it.stockIds) el.ele(NS.ord, "ord:stockItem").ele(NS.typ, "typ:stockItem").ele(NS.typ, "typ:ids").txt(it.stockIds);
          }
        }
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_delete_order",
    description: "Delete an order from POHODA by ID. Disabled unless CONNECTOR_ALLOW_DELETE=true.",
    kind: "delete",
    agenda: "order",
    schema: { id: z.number().describe("Order ID to delete (required)") },
    summary: (p) => `delete order id ${p.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `delete order ${p.id}` }, ids, (item) => {
        const ord = item.ele(NS.ord, "ord:order").att("version", "2.0");
        ord.ele(NS.ord, "ord:actionType").ele(NS.ord, "ord:delete").ele(NS.ftr, "ftr:filter").ele(NS.ftr, "ftr:id").txt(String(p.id));
      }),
  });
}
