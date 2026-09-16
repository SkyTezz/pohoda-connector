import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc, type XMLBuilder } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { toIsoDate } from "../core/shared.js";
import { addText, money, vatRateEnum } from "../xml/common.js";

const stockTargetSchema = z
  .object({
    id: z.number().int().optional().describe("Stock item ID"),
    code: z.string().max(64).optional().describe("Stock code"),
  })
  .refine((t) => t.id != null || t.code != null, { message: "give id or code" });

function addStockFilter(actionEl: XMLBuilder, target: z.infer<typeof stockTargetSchema>): void {
  const ftr = actionEl.ele(NS.ftr, "ftr:filter");
  if (target.id != null) ftr.ele(NS.ftr, "ftr:id").txt(String(target.id));
  else if (target.code) ftr.ele(NS.ftr, "ftr:code").txt(target.code);
}

const stockDetailFields = {
  unit: z.string().max(10).optional().describe("Unit of measure (ks, kg, m)"),
  purchasingPrice: z.number().optional(),
  sellingPrice: z.number().optional().describe("Selling price without VAT"),
  sellingPriceVAT: z.number().optional().describe("Selling price with VAT"),
  rateVAT: vatRateEnum.optional().describe("Selling VAT rate"),
  store: z.string().max(19).optional().describe("Warehouse IDS"),
  EAN: z.string().max(64).optional(),
  note: z.string().optional(),
  description: z.string().optional(),
};

const stockFields = {
  name: z.string().max(90).optional().describe("Stock item name"),
  ...stockDetailFields,
};

export function registerStockTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_stock",
    "Export stock/inventory items from POHODA with optional filters",
    {
      id: z.number().optional().describe("Stock item ID"),
      code: z.string().optional().describe("Stock code (supports wildcards *)"),
      name: z.string().optional().describe("Stock item name"),
      store: z.string().optional().describe("Store name filter"),
      lastChanges: z.string().optional().describe("Only items changed after this date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listStockRequest", NS.lStk, "lst:requestStock", (req) => {
          const hasFilter = Object.values(params).some((v) => v != null);
          if (!hasFilter) return;
          const ftr = req.ele(NS.ftr, "ftr:filter");
          if (params.id != null) ftr.ele(NS.ftr, "ftr:id").txt(String(params.id));
          if (params.code) ftr.ele(NS.ftr, "ftr:code").txt(params.code);
          if (params.name) ftr.ele(NS.ftr, "ftr:name").txt(params.name);
          if (params.store) ftr.ele(NS.ftr, "ftr:store").ele(NS.typ, "typ:ids").txt(params.store);
          if (params.lastChanges) ftr.ele(NS.ftr, "ftr:lastChanges").txt(toIsoDate(params.lastChanges));
        });
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Stock items", data, data.length);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_stock",
    description: "Create a stock card in POHODA (stockType card by default). The extId is set from the idempotency key.",
    kind: "create",
    agenda: "stock",
    schema: {
      code: z.string().max(64).describe("Unique stock code"),
      name: z.string().max(90).describe("Stock item name"),
      stockType: z.enum(["card", "text", "service", "package", "set", "product"]).optional().describe("Stock type (default card)"),
      quantity: z.number().optional().describe("Initial quantity"),
      ...stockDetailFields,
    },
    summary: (p) => `stock ${p.code} ${p.name}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `stock ${p.code}` }, ids, (item) => {
        const stk = item.ele(NS.stk, "stk:stock").att("version", "2.0");
        const hdr = stk.ele(NS.stk, "stk:stockHeader");
        const ext = hdr.ele(NS.stk, "stk:extId");
        ext.ele(NS.typ, "typ:ids").txt(ids.extIds);
        ext.ele(NS.typ, "typ:exSystemName").txt(c.config.extSystem);
        hdr.ele(NS.stk, "stk:stockType").txt(p.stockType ?? "card");
        hdr.ele(NS.stk, "stk:code").txt(p.code);
        addText(hdr, NS.stk, "stk:EAN", p.EAN);
        if (p.rateVAT) hdr.ele(NS.stk, "stk:sellingRateVAT").txt(p.rateVAT);
        hdr.ele(NS.stk, "stk:name").txt(p.name);
        addText(hdr, NS.stk, "stk:unit", p.unit);
        if (p.store) hdr.ele(NS.stk, "stk:storage").ele(NS.typ, "typ:ids").txt(p.store);
        if (p.purchasingPrice != null) hdr.ele(NS.stk, "stk:purchasingPrice").txt(money(p.purchasingPrice));
        if (p.sellingPrice != null) hdr.ele(NS.stk, "stk:sellingPrice").txt(money(p.sellingPrice));
        if (p.sellingPriceVAT != null) hdr.ele(NS.stk, "stk:sellingPriceVAT").txt(money(p.sellingPriceVAT));
        if (p.quantity != null) hdr.ele(NS.stk, "stk:count").txt(String(p.quantity));
        addText(hdr, NS.stk, "stk:description", p.description);
        addText(hdr, NS.stk, "stk:note", p.note);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_update_stock",
    description: "Update an existing stock card in POHODA, located by id or code. Only the given fields change.",
    kind: "update",
    agenda: "stock",
    schema: { target: stockTargetSchema.describe("Which stock card to update"), ...stockFields },
    summary: (p) => `update stock ${p.target.code ?? p.target.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `update stock ${p.target.code ?? p.target.id}` }, ids, (item) => {
        const stk = item.ele(NS.stk, "stk:stock").att("version", "2.0");
        addStockFilter(stk.ele(NS.stk, "stk:actionType").ele(NS.stk, "stk:update"), p.target);
        const hdr = stk.ele(NS.stk, "stk:stockHeader");
        addText(hdr, NS.stk, "stk:EAN", p.EAN);
        if (p.rateVAT) hdr.ele(NS.stk, "stk:sellingRateVAT").txt(p.rateVAT);
        addText(hdr, NS.stk, "stk:name", p.name);
        addText(hdr, NS.stk, "stk:unit", p.unit);
        if (p.store) hdr.ele(NS.stk, "stk:storage").ele(NS.typ, "typ:ids").txt(p.store);
        if (p.purchasingPrice != null) hdr.ele(NS.stk, "stk:purchasingPrice").txt(money(p.purchasingPrice));
        if (p.sellingPrice != null) hdr.ele(NS.stk, "stk:sellingPrice").txt(money(p.sellingPrice));
        if (p.sellingPriceVAT != null) hdr.ele(NS.stk, "stk:sellingPriceVAT").txt(money(p.sellingPriceVAT));
        addText(hdr, NS.stk, "stk:description", p.description);
        addText(hdr, NS.stk, "stk:note", p.note);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_delete_stock",
    description: "Delete a stock card from POHODA. Disabled unless CONNECTOR_ALLOW_DELETE=true.",
    kind: "delete",
    agenda: "stock",
    schema: { target: stockTargetSchema },
    summary: (p) => `delete stock ${p.target.code ?? p.target.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `delete stock ${p.target.code ?? p.target.id}` }, ids, (item) => {
        const stk = item.ele(NS.stk, "stk:stock").att("version", "2.0");
        addStockFilter(stk.ele(NS.stk, "stk:actionType").ele(NS.stk, "stk:delete"), p.target);
      }),
  });

  host.tool("pohoda_list_stores", "Export list of stores (warehouses) from POHODA", {}, async () => {
    try {
      const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listStoreRequest", NS.lst, "lst:requestStore");
      const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
      return jsonResult("Stores", data, data.length);
    } catch (e) {
      return err((e as Error).message);
    }
  });
}
