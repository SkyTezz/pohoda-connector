import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { applyFilter } from "../core/filters.js";
import {
  accountingSchema,
  addAccounting,
  addClassificationVAT,
  addDate,
  addExtId,
  addNumberRequested,
  addPartnerIdentity,
  addRef,
  addText,
  classificationVATSchema,
  hasPartner,
  money,
  partnerSchema,
  refSchema,
  vatRateEnum,
} from "../xml/common.js";

const intDocItemSchema = z.object({
  text: z.string().max(90),
  quantity: z.number().default(1),
  unit: z.string().max(10).optional(),
  unitPrice: z.number(),
  payVAT: z.boolean().optional().describe("true = unitPrice includes VAT (DPH shora)"),
  rateVAT: vatRateEnum.default("none"),
  accounting: accountingSchema.optional(),
  classificationVAT: classificationVATSchema.optional().describe("Per-line VAT classification"),
  symPar: z.string().max(20).optional(),
  centre: refSchema.optional(),
  activity: refSchema.optional(),
  contract: refSchema.optional(),
});

export function registerInternalDocTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_internal_docs",
    "List internal documents from POHODA. Supports filtering by ID, date range, or last changes. Returns JSON array of matching records.",
    {
      id: z.number().optional().describe("Filter by internal document ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listIntDocRequest", NS.lst, "lst:requestIntDoc", (req) => applyFilter(req, params));
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Internal documents", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_internal_doc",
    description:
      "Create an internal document (interní doklad) in POHODA with pre-accounting and per-line VAT classification — e.g. the §90 margin-scheme VAT entry (line 1: supply minus margin at 0 % with UDobch, line 2: margin with UD and VAT calculated from the gross amount).",
    kind: "create",
    agenda: "internalDoc",
    schema: {
      number: z.string().max(32).optional().describe("Requested document number"),
      symVar: z.string().max(20).optional(),
      symPar: z.string().max(20).optional(),
      date: z.string().describe("Document date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTax: z.string().optional(),
      dateAccounting: z.string().optional(),
      dateKHDPH: z.string().optional(),
      accounting: accountingSchema.optional(),
      classificationVAT: classificationVATSchema.optional(),
      text: z.string().max(240).describe("Document text — POHODA requires it"),
      partner: partnerSchema.optional(),
      centre: refSchema.optional(),
      activity: refSchema.optional(),
      contract: refSchema.optional(),
      note: z.string().optional(),
      intNote: z.string().optional(),
      extIdText: z.string().optional(),
      items: z.array(intDocItemSchema).min(1).describe("Line items"),
    },
    summary: (p) => `internal doc ${p.number ?? ""} ${p.date} ${p.text}`.slice(0, 120),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `intDoc ${p.date}` }, ids, (item) => {
        const doc = item.ele(NS.int, "int:intDoc").att("version", "2.0");
        const header = doc.ele(NS.int, "int:intDocHeader");
        addExtId(header, NS.int, "int", ids.extIds, c.config.extSystem, p.extIdText);
        if (p.number) addNumberRequested(header, NS.int, "int", p.number);
        addText(header, NS.int, "int:symVar", p.symVar);
        addText(header, NS.int, "int:symPar", p.symPar);
        addDate(header, NS.int, "int:date", p.date);
        addDate(header, NS.int, "int:dateTax", p.dateTax);
        addDate(header, NS.int, "int:dateAccounting", p.dateAccounting);
        addDate(header, NS.int, "int:dateKHDPH", p.dateKHDPH);
        if (p.accounting) addAccounting(header, NS.int, "int", p.accounting);
        if (p.classificationVAT) addClassificationVAT(header, NS.int, "int", p.classificationVAT);
        addText(header, NS.int, "int:text", p.text);
        if (hasPartner(p.partner)) addPartnerIdentity(header, NS.int, "int", p.partner, c.config.extSystem);
        if (p.centre) addRef(header, NS.int, "int:centre", p.centre);
        if (p.activity) addRef(header, NS.int, "int:activity", p.activity);
        if (p.contract) addRef(header, NS.int, "int:contract", p.contract);
        addText(header, NS.int, "int:note", p.note);
        addText(header, NS.int, "int:intNote", p.intNote);

        const detail = doc.ele(NS.int, "int:intDocDetail");
        for (const it of p.items) {
          const el = detail.ele(NS.int, "int:intDocItem");
          el.ele(NS.int, "int:text").txt(it.text);
          el.ele(NS.int, "int:quantity").txt(String(it.quantity));
          if (it.unit) el.ele(NS.int, "int:unit").txt(it.unit);
          el.ele(NS.int, "int:payVAT").txt(it.payVAT ? "true" : "false");
          el.ele(NS.int, "int:rateVAT").txt(it.rateVAT);
          el.ele(NS.int, "int:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(it.unitPrice));
          addText(el, NS.int, "int:symPar", it.symPar);
          if (it.accounting) addAccounting(el, NS.int, "int", it.accounting);
          if (it.classificationVAT) addClassificationVAT(el, NS.int, "int", it.classificationVAT);
          if (it.centre) addRef(el, NS.int, "int:centre", it.centre);
          if (it.activity) addRef(el, NS.int, "int:activity", it.activity);
          if (it.contract) addRef(el, NS.int, "int:contract", it.contract);
        }
        doc.ele(NS.int, "int:intDocSummary");
      }),
  });
}
