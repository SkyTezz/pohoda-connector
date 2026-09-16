import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc, type XMLBuilder } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { applyInvoiceFilter, type InvoiceFilterParams } from "../core/filters.js";
import {
  accountingSchema,
  addAccounting,
  addClassificationVAT,
  addDate,
  addExtId,
  addForeignCurrency,
  addNumberRequested,
  addPartnerIdentity,
  addPaymentType,
  addRef,
  addSourceDocument,
  addText,
  classificationVATSchema,
  foreignCurrencySchema,
  hasPartner,
  money,
  partnerSchema,
  paymentSchema,
  refSchema,
  roundingDocumentEnum,
  sourceDocumentSchema,
  vatRateEnum,
} from "../xml/common.js";

/** invoiceTypeType from invoice.xsd (v2.0), complete. */
export const invoiceTypeEnum = z.enum([
  "issuedInvoice",
  "issuedCreditNotice",
  "issuedDebitNote",
  "issuedAdvanceInvoice",
  "receivable",
  "issuedProformaInvoice",
  "penalty",
  "issuedCorrectiveTax",
  "receivedInvoice",
  "receivedCreditNotice",
  "receivedDebitNote",
  "receivedAdvanceInvoice",
  "commitment",
  "receivedProformaInvoice",
  "receivedCorrectiveTax",
]);

const invoiceItemSchema = z.object({
  text: z.string().max(90).describe("Item text (max 90 chars)"),
  quantity: z.number().default(1),
  unit: z.string().max(10).optional(),
  unitPrice: z.number().describe("Unit price; with VAT when payVAT=true, without VAT otherwise"),
  payVAT: z.boolean().optional().describe("true = unitPrice includes VAT (default false)"),
  rateVAT: vatRateEnum.default("none"),
  discountPercentage: z.number().min(0).max(100).optional(),
  code: z.string().max(64).optional().describe("Item code"),
  stockIds: z.string().max(64).optional().describe("Stock card IDS/code — makes this a stock item (moves stock)"),
  note: z.string().max(90).optional(),
  accounting: accountingSchema.optional().describe("Item pre-accounting; overrides the header"),
  classificationVAT: classificationVATSchema.optional().describe("Item VAT classification; overrides the header"),
  centre: refSchema.optional(),
  activity: refSchema.optional(),
  contract: refSchema.optional(),
});

const advancePaymentSchema = z.object({
  sourceDocument: sourceDocumentSchema.describe("The advance invoice (zálohová faktura) being deducted; omit for a manual deduction"),
  amount: z.number().describe("Deducted amount (unit price of the deduction item)"),
  payVAT: z.boolean().default(false),
  rateVAT: vatRateEnum.default("none"),
});

const invoiceHeaderFields = {
  number: z.string().max(32).optional().describe("Requested document number (numberRequested); POHODA's own series when omitted"),
  checkNumberDuplicity: z.boolean().optional().describe("Refuse if the requested number already exists (default true)"),
  date: z.string().describe("Issue date (DD.MM.YYYY or YYYY-MM-DD)"),
  dateTax: z.string().optional().describe("Taxable supply date (defaults to date)"),
  dateAccounting: z.string().optional().describe("Accounting date (defaults to date)"),
  dateDue: z.string().optional().describe("Due date"),
  dateKHDPH: z.string().optional().describe("VAT control statement date (received documents)"),
  symVar: z.string().max(20).optional().describe("Variable symbol (defaults to number)"),
  symConst: z.string().max(4).optional(),
  symSpec: z.string().max(16).optional(),
  symPar: z.string().max(20).optional().describe("Pairing symbol"),
  accounting: accountingSchema.optional().describe("Pre-accounting (předkontace) for the document"),
  classificationVAT: classificationVATSchema.optional().describe("VAT classification (členění DPH), default inland"),
  text: z.string().max(240).describe("Document text — POHODA requires it"),
  partner: partnerSchema.optional().describe("Customer / supplier identity"),
  numberOrder: z.string().max(32).optional().describe("Related order number"),
  dateOrder: z.string().optional(),
  paymentType: paymentSchema.optional().describe("Form of payment"),
  account: refSchema.optional().describe("Bank account / cash register to be paid to (receivables only)"),
  centre: refSchema.optional(),
  activity: refSchema.optional(),
  contract: refSchema.optional(),
  foreignCurrency: foreignCurrencySchema.optional().describe("Set for EUR etc.; item unit prices are then in that currency"),
  roundingDocument: roundingDocumentEnum.optional().describe("Document rounding; none keeps the totals exactly as sent"),
  note: z.string().optional(),
  intNote: z.string().optional(),
  extIdText: z.string().optional().describe("Free text stored with the extId (e.g. source system document code)"),
};

type InvoiceHeaderParams = z.objectOutputType<typeof invoiceHeaderFields, z.ZodTypeAny>;

function buildInvoiceHeader(inv: XMLBuilder, params: InvoiceHeaderParams & { invoiceType: string }, extIds: string, exSystem: string): void {
  const header = inv.ele(NS.inv, "inv:invoiceHeader");
  addExtId(header, NS.inv, "inv", extIds, exSystem, params.extIdText);
  header.ele(NS.inv, "inv:invoiceType").txt(params.invoiceType);
  if (params.number) addNumberRequested(header, NS.inv, "inv", params.number, params.checkNumberDuplicity ?? true);
  addText(header, NS.inv, "inv:symVar", params.symVar);
  addText(header, NS.inv, "inv:symPar", params.symPar);
  addDate(header, NS.inv, "inv:date", params.date);
  addDate(header, NS.inv, "inv:dateTax", params.dateTax);
  addDate(header, NS.inv, "inv:dateAccounting", params.dateAccounting);
  addDate(header, NS.inv, "inv:dateKHDPH", params.dateKHDPH);
  addDate(header, NS.inv, "inv:dateDue", params.dateDue);
  if (params.accounting) addAccounting(header, NS.inv, "inv", params.accounting);
  if (params.classificationVAT) addClassificationVAT(header, NS.inv, "inv", params.classificationVAT);
  addText(header, NS.inv, "inv:text", params.text);
  if (hasPartner(params.partner)) addPartnerIdentity(header, NS.inv, "inv", params.partner, exSystem);
  addText(header, NS.inv, "inv:numberOrder", params.numberOrder);
  addDate(header, NS.inv, "inv:dateOrder", params.dateOrder);
  if (params.paymentType) addPaymentType(header, NS.inv, "inv", params.paymentType);
  if (params.account) addRef(header, NS.inv, "inv:account", params.account);
  addText(header, NS.inv, "inv:symConst", params.symConst);
  addText(header, NS.inv, "inv:symSpec", params.symSpec);
  if (params.centre) addRef(header, NS.inv, "inv:centre", params.centre);
  if (params.activity) addRef(header, NS.inv, "inv:activity", params.activity);
  if (params.contract) addRef(header, NS.inv, "inv:contract", params.contract);
  addText(header, NS.inv, "inv:note", params.note);
  addText(header, NS.inv, "inv:intNote", params.intNote);
}

function buildInvoiceDetail(
  inv: XMLBuilder,
  items: z.infer<typeof invoiceItemSchema>[] | undefined,
  advances: z.infer<typeof advancePaymentSchema>[] | undefined,
  foreign: boolean,
  exSystem: string,
): void {
  if (!items?.length && !advances?.length) return;
  const detail = inv.ele(NS.inv, "inv:invoiceDetail");
  for (const it of items ?? []) {
    const el = detail.ele(NS.inv, "inv:invoiceItem");
    el.ele(NS.inv, "inv:text").txt(it.text);
    el.ele(NS.inv, "inv:quantity").txt(String(it.quantity));
    if (it.unit) el.ele(NS.inv, "inv:unit").txt(it.unit);
    el.ele(NS.inv, "inv:payVAT").txt(it.payVAT ? "true" : "false");
    el.ele(NS.inv, "inv:rateVAT").txt(it.rateVAT);
    if (it.discountPercentage != null) el.ele(NS.inv, "inv:discountPercentage").txt(String(it.discountPercentage));
    el.ele(NS.inv, foreign ? "inv:foreignCurrency" : "inv:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(it.unitPrice));
    if (it.note) el.ele(NS.inv, "inv:note").txt(it.note);
    if (it.code) el.ele(NS.inv, "inv:code").txt(it.code);
    if (it.stockIds) el.ele(NS.inv, "inv:stockItem").ele(NS.typ, "typ:stockItem").ele(NS.typ, "typ:ids").txt(it.stockIds);
    if (it.accounting) addAccounting(el, NS.inv, "inv", it.accounting);
    if (it.classificationVAT) addClassificationVAT(el, NS.inv, "inv", it.classificationVAT);
    if (it.centre) addRef(el, NS.inv, "inv:centre", it.centre);
    if (it.activity) addRef(el, NS.inv, "inv:activity", it.activity);
    if (it.contract) addRef(el, NS.inv, "inv:contract", it.contract);
  }
  for (const adv of advances ?? []) {
    const el = detail.ele(NS.inv, "inv:invoiceAdvancePaymentItem");
    addSourceDocument(el, NS.inv, "inv:sourceDocument", adv.sourceDocument, exSystem);
    el.ele(NS.inv, "inv:quantity").txt("1");
    el.ele(NS.inv, "inv:payVAT").txt(adv.payVAT ? "true" : "false");
    el.ele(NS.inv, "inv:rateVAT").txt(adv.rateVAT);
    el.ele(NS.inv, foreign ? "inv:foreignCurrency" : "inv:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(adv.amount));
  }
}

function buildInvoiceSummary(inv: XMLBuilder, params: InvoiceHeaderParams): void {
  const summary = inv.ele(NS.inv, "inv:invoiceSummary");
  if (params.roundingDocument) summary.ele(NS.inv, "inv:roundingDocument").txt(params.roundingDocument);
  if (params.foreignCurrency) addForeignCurrency(summary, NS.inv, "inv", params.foreignCurrency);
}

export function registerInvoiceTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_invoices",
    "List invoices from POHODA. Supports filtering by invoice type, ID, date range, variable symbol, company name, IČO, or last changes. Returns JSON array of matching invoice records.",
    {
      invoiceType: invoiceTypeEnum.optional().describe("Filter by invoice type"),
      id: z.number().optional().describe("Filter by invoice ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      variableSymbol: z.string().optional().describe("Filter by variable symbol"),
      companyName: z.string().optional().describe("Filter by company name"),
      ico: z.string().optional().describe("Filter by IČO"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listInvoiceRequest", NS.lst, "lst:requestInvoice", (req) => {
          if (params.invoiceType) req.att("invoiceType", params.invoiceType);
          const filterParams: InvoiceFilterParams = {
            id: params.id,
            dateFrom: params.dateFrom,
            dateTill: params.dateTill,
            variableSymbol: params.variableSymbol,
            companyName: params.companyName,
            ico: params.ico,
            lastChanges: params.lastChanges,
          };
          applyInvoiceFilter(req, filterParams);
        });
        const response = await ctx.client.sendXml(xml);
        const data = extractListData(parseResponse(response));
        return jsonResult("Invoices", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_invoice",
    description:
      "Create an invoice in POHODA (issued/received/advance/credit note/receivable/commitment) with pre-accounting, VAT classification, payment form, partner, items and advance deductions. The extId is set from the idempotency key.",
    kind: "create",
    agenda: "invoice",
    schema: {
      invoiceType: invoiceTypeEnum.describe("Invoice type (required)"),
      ...invoiceHeaderFields,
      items: z.array(invoiceItemSchema).optional().describe("Line items"),
      advancePayments: z.array(advancePaymentSchema).optional().describe("Advance invoices to deduct (odpočet zálohy)"),
    },
    summary: (p) => `${p.invoiceType} ${p.number ?? "(POHODA number)"} ${p.date} ${p.partner?.company ?? p.partner?.name ?? ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `${p.invoiceType} ${p.number ?? ""}`.trim() }, ids, (item) => {
        const inv = item.ele(NS.inv, "inv:invoice").att("version", "2.0");
        buildInvoiceHeader(inv, p, ids.extIds, c.config.extSystem);
        buildInvoiceDetail(inv, p.items, p.advancePayments, p.foreignCurrency != null, c.config.extSystem);
        buildInvoiceSummary(inv, p);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_create_corrective_invoice",
    description:
      "Create an opravný daňový doklad (corrective tax document / credit note) to an existing invoice via the correctiveDocument block: POHODA finds the source document and creates the corrective document from the header and items given. Verify on a sandbox unit before production use.",
    kind: "create",
    agenda: "invoice",
    schema: {
      sourceDocument: sourceDocumentSchema.describe("The invoice being corrected (number, id or extId)"),
      invoiceType: invoiceTypeEnum.default("issuedCorrectiveTax").describe("Type of the corrective document"),
      ...invoiceHeaderFields,
      items: z.array(invoiceItemSchema).optional().describe("Corrective items (negative quantities reduce the original)"),
    },
    summary: (p) => `corrective ${p.invoiceType} to ${p.sourceDocument.number ?? p.sourceDocument.extId ?? p.sourceDocument.id} ${p.date}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `corrective to ${p.sourceDocument.number ?? ""}` }, ids, (item) => {
        const inv = item.ele(NS.inv, "inv:invoice").att("version", "2.0");
        const corrective = inv.ele(NS.inv, "inv:correctiveDocument");
        addSourceDocument(corrective, NS.typ, "typ:sourceDocument", p.sourceDocument, c.config.extSystem);
        buildInvoiceHeader(inv, p, ids.extIds, c.config.extSystem);
        buildInvoiceDetail(inv, p.items, undefined, p.foreignCurrency != null, c.config.extSystem);
        buildInvoiceSummary(inv, p);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_cancel_invoice",
    description:
      "Storno an invoice: POHODA finds the source document and creates the cancelling (storno) document (cancelDocument block). Documents are never deleted. Verify on a sandbox unit before production use.",
    kind: "create",
    agenda: "invoice",
    schema: {
      sourceDocument: sourceDocumentSchema.describe("The invoice to cancel (number, id or extId)"),
      extIdText: z.string().optional().describe("Free text stored with the extId of the storno document"),
    },
    summary: (p) => `storno invoice ${p.sourceDocument.number ?? p.sourceDocument.extId ?? p.sourceDocument.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `storno ${p.sourceDocument.number ?? ""}` }, ids, (item) => {
        const inv = item.ele(NS.inv, "inv:invoice").att("version", "2.0");
        const cancel = inv.ele(NS.inv, "inv:cancelDocument");
        addSourceDocument(cancel, NS.typ, "typ:sourceDocument", p.sourceDocument, c.config.extSystem);
        const header = inv.ele(NS.inv, "inv:invoiceHeader");
        addExtId(header, NS.inv, "inv", ids.extIds, c.config.extSystem, p.extIdText);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_delete_invoice",
    description: "Delete an invoice from POHODA by ID. Disabled unless CONNECTOR_ALLOW_DELETE=true; prefer pohoda_cancel_invoice.",
    kind: "delete",
    agenda: "invoice",
    schema: { id: z.number().describe("Invoice ID to delete (required)") },
    summary: (p) => `delete invoice id ${p.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `delete invoice ${p.id}` }, ids, (item) => {
        const inv = item.ele(NS.inv, "inv:invoice").att("version", "2.0");
        const del = inv.ele(NS.inv, "inv:actionType").ele(NS.inv, "inv:delete");
        del.ele(NS.ftr, "ftr:filter").ele(NS.ftr, "ftr:id").txt(String(p.id));
      }),
  });
}
