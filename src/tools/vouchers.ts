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
  addForeignCurrency,
  addLiquidationItem,
  addNumberRequested,
  addPartnerIdentity,
  addRef,
  addSourceDocument,
  addText,
  classificationVATSchema,
  foreignCurrencySchema,
  hasPartner,
  liquidationSchema,
  money,
  partnerSchema,
  refSchema,
  sourceDocumentSchema,
  vatRateEnum,
} from "../xml/common.js";

const voucherTypeEnum = z.enum(["receipt", "expense"]);

const voucherItemSchema = z.object({
  text: z.string().max(90),
  quantity: z.number().default(1),
  unit: z.string().max(10).optional(),
  unitPrice: z.number(),
  payVAT: z.boolean().optional().describe("true = unitPrice includes VAT (typical for cash sales)"),
  rateVAT: vatRateEnum.default("none"),
  discountPercentage: z.number().min(0).max(100).optional(),
  code: z.string().max(64).optional(),
  stockIds: z.string().max(64).optional().describe("Stock card IDS — makes this a stock item"),
  note: z.string().max(90).optional(),
  accounting: accountingSchema.optional(),
  classificationVAT: classificationVATSchema.optional().describe("Per-line VAT classification (e.g. UDobch for §90 goods, UKosv for §92 gold)"),
  centre: refSchema.optional(),
  activity: refSchema.optional(),
  contract: refSchema.optional(),
});

export function registerVoucherTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_vouchers",
    "List cash vouchers (receipts and expenses) from POHODA. Supports filtering by ID, date range, company name, or last changes. Returns JSON array of matching records.",
    {
      id: z.number().optional().describe("Filter by voucher ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      companyName: z.string().optional().describe("Filter by company name"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listCashRequest", NS.lst, "lst:requestCash", (req) => applyFilter(req, params));
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Vouchers", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_voucher",
    description:
      "Create a cash voucher (pokladní doklad: receipt or expense) in POHODA with cash register, pre-accounting, VAT classification, items (text or stock) and optional liquidation of invoices paid in cash.",
    kind: "create",
    agenda: "voucher",
    schema: {
      voucherType: voucherTypeEnum.describe("receipt = příjmový, expense = výdajový"),
      cashAccount: refSchema.describe("Cash register (pokladna) — required by POHODA"),
      number: z.string().max(32).optional().describe("Requested document number"),
      date: z.string().describe("Document date (DD.MM.YYYY or YYYY-MM-DD)"),
      datePayment: z.string().optional(),
      dateTax: z.string().optional().describe("Taxable supply date"),
      accounting: accountingSchema.optional(),
      classificationVAT: classificationVATSchema.optional(),
      text: z.string().max(240).describe("Document text — POHODA requires it"),
      partner: partnerSchema.optional(),
      symPar: z.string().max(20).optional(),
      centre: refSchema.optional(),
      activity: refSchema.optional(),
      contract: refSchema.optional(),
      foreignCurrency: foreignCurrencySchema.optional(),
      note: z.string().optional(),
      intNote: z.string().optional(),
      extIdText: z.string().optional(),
      items: z.array(voucherItemSchema).optional().describe("Line items"),
      liquidations: z.array(liquidationSchema).optional().describe("Invoices paid by this voucher (likvidace)"),
    },
    summary: (p) => `voucher ${p.voucherType} ${p.date} ${p.cashAccount.ids ?? p.cashAccount.id} ${p.text}`.slice(0, 120),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `voucher ${p.voucherType} ${p.date}` }, ids, (item) => {
        const vch = item.ele(NS.vch, "vch:voucher").att("version", "2.0");
        const header = vch.ele(NS.vch, "vch:voucherHeader");
        addExtId(header, NS.vch, "vch", ids.extIds, c.config.extSystem, p.extIdText);
        header.ele(NS.vch, "vch:voucherType").txt(p.voucherType);
        addRef(header, NS.vch, "vch:cashAccount", p.cashAccount);
        if (p.number) addNumberRequested(header, NS.vch, "vch", p.number);
        addDate(header, NS.vch, "vch:date", p.date);
        addDate(header, NS.vch, "vch:datePayment", p.datePayment);
        addDate(header, NS.vch, "vch:dateTax", p.dateTax);
        if (p.accounting) addAccounting(header, NS.vch, "vch", p.accounting);
        if (p.classificationVAT) addClassificationVAT(header, NS.vch, "vch", p.classificationVAT);
        addText(header, NS.vch, "vch:text", p.text);
        if (hasPartner(p.partner)) addPartnerIdentity(header, NS.vch, "vch", p.partner, c.config.extSystem);
        addText(header, NS.vch, "vch:symPar", p.symPar);
        if (p.centre) addRef(header, NS.vch, "vch:centre", p.centre);
        if (p.activity) addRef(header, NS.vch, "vch:activity", p.activity);
        if (p.contract) addRef(header, NS.vch, "vch:contract", p.contract);
        addText(header, NS.vch, "vch:note", p.note);
        addText(header, NS.vch, "vch:intNote", p.intNote);

        if (p.items?.length || p.liquidations?.length) {
          const detail = vch.ele(NS.vch, "vch:voucherDetail");
          for (const it of p.items ?? []) {
            const el = detail.ele(NS.vch, "vch:voucherItem");
            el.ele(NS.vch, "vch:text").txt(it.text);
            el.ele(NS.vch, "vch:quantity").txt(String(it.quantity));
            if (it.unit) el.ele(NS.vch, "vch:unit").txt(it.unit);
            el.ele(NS.vch, "vch:payVAT").txt(it.payVAT ? "true" : "false");
            el.ele(NS.vch, "vch:rateVAT").txt(it.rateVAT);
            if (it.discountPercentage != null) el.ele(NS.vch, "vch:discountPercentage").txt(String(it.discountPercentage));
            el.ele(NS.vch, p.foreignCurrency ? "vch:foreignCurrency" : "vch:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(it.unitPrice));
            if (it.note) el.ele(NS.vch, "vch:note").txt(it.note);
            if (it.code) el.ele(NS.vch, "vch:code").txt(it.code);
            if (it.stockIds) el.ele(NS.vch, "vch:stockItem").ele(NS.typ, "typ:stockItem").ele(NS.typ, "typ:ids").txt(it.stockIds);
            if (it.accounting) addAccounting(el, NS.vch, "vch", it.accounting);
            if (it.classificationVAT) addClassificationVAT(el, NS.vch, "vch", it.classificationVAT);
            if (it.centre) addRef(el, NS.vch, "vch:centre", it.centre);
            if (it.activity) addRef(el, NS.vch, "vch:activity", it.activity);
            if (it.contract) addRef(el, NS.vch, "vch:contract", it.contract);
          }
          for (const liq of p.liquidations ?? []) addLiquidationItem(detail, NS.vch, "vch", "voucherLiquidationItem", liq, c.config.extSystem, "voucher");
        }
        if (p.foreignCurrency) addForeignCurrency(vch.ele(NS.vch, "vch:voucherSummary"), NS.vch, "vch", p.foreignCurrency);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_cancel_voucher",
    description: "Storno a cash voucher: POHODA finds the source document and creates the cancelling document (cancelDocument block). Verify on a sandbox unit before production use.",
    kind: "create",
    agenda: "voucher",
    schema: {
      sourceDocument: sourceDocumentSchema.describe("The voucher to cancel (number, id or extId)"),
      extIdText: z.string().optional(),
    },
    summary: (p) => `storno voucher ${p.sourceDocument.number ?? p.sourceDocument.extId ?? p.sourceDocument.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `storno voucher ${p.sourceDocument.number ?? ""}` }, ids, (item) => {
        const vch = item.ele(NS.vch, "vch:voucher").att("version", "2.0");
        addSourceDocument(vch.ele(NS.vch, "vch:cancelDocument"), NS.typ, "typ:sourceDocument", p.sourceDocument, c.config.extSystem);
        addExtId(vch.ele(NS.vch, "vch:voucherHeader"), NS.vch, "vch", ids.extIds, c.config.extSystem, p.extIdText);
      }),
  });
}
