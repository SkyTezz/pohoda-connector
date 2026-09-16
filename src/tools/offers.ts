import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { applyFilter, type ListFilterParams } from "../core/filters.js";
import { addDate, addExtId, addPartnerIdentity, addText, hasPartner, money, partnerSchema, vatRateEnum } from "../xml/common.js";

const offerTypeEnum = z.enum(["issuedOffer", "receivedOffer"]);

const offerItemSchema = z.object({
  text: z.string().max(90),
  quantity: z.number().default(1),
  unitPrice: z.number(),
  payVAT: z.boolean().optional(),
  rateVAT: vatRateEnum.default("none"),
  unit: z.string().max(10).optional(),
});

export function registerOfferTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_offers",
    "List offers from POHODA. Supports filtering by offer type (issued/received), ID, date range, company name, or last changes. Returns JSON array of matching offer records.",
    {
      offerType: offerTypeEnum.optional().describe("Filter by offer type (issuedOffer or receivedOffer)"),
      id: z.number().optional().describe("Filter by offer ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      companyName: z.string().optional().describe("Filter by company name"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listOfferRequest", NS.lst, "lst:requestOffer", (req) => {
          if (params.offerType) req.att("offerType", params.offerType);
          const filterParams: ListFilterParams = { id: params.id, dateFrom: params.dateFrom, dateTill: params.dateTill, companyName: params.companyName, lastChanges: params.lastChanges };
          applyFilter(req, filterParams);
        });
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Offers", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_offer",
    description: "Create an offer (issued or received) in POHODA with partner and line items.",
    kind: "create",
    agenda: "offer",
    schema: {
      offerType: offerTypeEnum.describe("issuedOffer or receivedOffer"),
      date: z.string().describe("Offer date (DD.MM.YYYY or YYYY-MM-DD)"),
      text: z.string().max(240).optional(),
      partner: partnerSchema.optional(),
      note: z.string().optional(),
      items: z.array(offerItemSchema).optional(),
    },
    summary: (p) => `${p.offerType} ${p.date} ${p.text ?? ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `${p.offerType} ${p.date}` }, ids, (item) => {
        const ofr = item.ele(NS.ofr, "ofr:offer").att("version", "2.0");
        const header = ofr.ele(NS.ofr, "ofr:offerHeader");
        addExtId(header, NS.ofr, "ofr", ids.extIds, c.config.extSystem);
        header.ele(NS.ofr, "ofr:offerType").txt(p.offerType);
        addDate(header, NS.ofr, "ofr:date", p.date);
        addText(header, NS.ofr, "ofr:text", p.text);
        if (hasPartner(p.partner)) addPartnerIdentity(header, NS.ofr, "ofr", p.partner, c.config.extSystem);
        addText(header, NS.ofr, "ofr:note", p.note);
        if (p.items?.length) {
          const detail = ofr.ele(NS.ofr, "ofr:offerDetail");
          for (const it of p.items) {
            const el = detail.ele(NS.ofr, "ofr:offerItem");
            el.ele(NS.ofr, "ofr:text").txt(it.text);
            el.ele(NS.ofr, "ofr:quantity").txt(String(it.quantity));
            if (it.unit) el.ele(NS.ofr, "ofr:unit").txt(it.unit);
            el.ele(NS.ofr, "ofr:payVAT").txt(it.payVAT ? "true" : "false");
            el.ele(NS.ofr, "ofr:rateVAT").txt(it.rateVAT);
            el.ele(NS.ofr, "ofr:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(it.unitPrice));
          }
        }
      }),
  });
}
