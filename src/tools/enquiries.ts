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

const enquiryTypeEnum = z.enum(["issuedEnquiry", "receivedEnquiry"]);

const enquiryItemSchema = z.object({
  text: z.string().max(90),
  quantity: z.number().default(1),
  unitPrice: z.number(),
  payVAT: z.boolean().optional(),
  rateVAT: vatRateEnum.default("none"),
  unit: z.string().max(10).optional(),
});

export function registerEnquiryTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_enquiries",
    "List enquiries from POHODA. Supports filtering by enquiry type (issued/received), ID, date range, company name, or last changes. Returns JSON array of matching enquiry records.",
    {
      enquiryType: enquiryTypeEnum.optional().describe("Filter by enquiry type (issuedEnquiry or receivedEnquiry)"),
      id: z.number().optional().describe("Filter by enquiry ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      companyName: z.string().optional().describe("Filter by company name"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listEnquiryRequest", NS.lst, "lst:requestEnquiry", (req) => {
          if (params.enquiryType) req.att("enquiryType", params.enquiryType);
          const filterParams: ListFilterParams = { id: params.id, dateFrom: params.dateFrom, dateTill: params.dateTill, companyName: params.companyName, lastChanges: params.lastChanges };
          applyFilter(req, filterParams);
        });
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Enquiries", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_enquiry",
    description: "Create an enquiry (issued or received) in POHODA with partner and line items.",
    kind: "create",
    agenda: "enquiry",
    schema: {
      enquiryType: enquiryTypeEnum.describe("issuedEnquiry or receivedEnquiry"),
      date: z.string().describe("Enquiry date (DD.MM.YYYY or YYYY-MM-DD)"),
      text: z.string().max(240).optional(),
      partner: partnerSchema.optional(),
      note: z.string().optional(),
      items: z.array(enquiryItemSchema).optional(),
    },
    summary: (p) => `${p.enquiryType} ${p.date} ${p.text ?? ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `${p.enquiryType} ${p.date}` }, ids, (item) => {
        const enq = item.ele(NS.enq, "enq:enquiry").att("version", "2.0");
        const header = enq.ele(NS.enq, "enq:enquiryHeader");
        addExtId(header, NS.enq, "enq", ids.extIds, c.config.extSystem);
        header.ele(NS.enq, "enq:enquiryType").txt(p.enquiryType);
        addDate(header, NS.enq, "enq:date", p.date);
        addText(header, NS.enq, "enq:text", p.text);
        if (hasPartner(p.partner)) addPartnerIdentity(header, NS.enq, "enq", p.partner, c.config.extSystem);
        addText(header, NS.enq, "enq:note", p.note);
        if (p.items?.length) {
          const detail = enq.ele(NS.enq, "enq:enquiryDetail");
          for (const it of p.items) {
            const el = detail.ele(NS.enq, "enq:enquiryItem");
            el.ele(NS.enq, "enq:text").txt(it.text);
            el.ele(NS.enq, "enq:quantity").txt(String(it.quantity));
            if (it.unit) el.ele(NS.enq, "enq:unit").txt(it.unit);
            el.ele(NS.enq, "enq:payVAT").txt(it.payVAT ? "true" : "false");
            el.ele(NS.enq, "enq:rateVAT").txt(it.rateVAT);
            el.ele(NS.enq, "enq:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(it.unitPrice));
          }
        }
      }),
  });
}
