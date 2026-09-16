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
  addText,
  classificationVATSchema,
  foreignCurrencySchema,
  hasPartner,
  liquidationSchema,
  money,
  partnerSchema,
  refSchema,
  vatRateEnum,
} from "../xml/common.js";

const bankTypeEnum = z.enum(["receipt", "expense"]);

const bankItemSchema = z.object({
  text: z.string().max(90),
  quantity: z.number().default(1),
  unitPrice: z.number(),
  payVAT: z.boolean().optional().describe("true = unitPrice includes VAT"),
  rateVAT: vatRateEnum.default("none"),
  accounting: accountingSchema.optional(),
  classificationVAT: classificationVATSchema.optional(),
  centre: refSchema.optional(),
  activity: refSchema.optional(),
  contract: refSchema.optional(),
});

export function registerBankTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_bank",
    "List bank documents (receipts and expenses) from POHODA. Supports filtering by ID, date range, company name, or last changes. Returns JSON array of matching records.",
    {
      id: z.number().optional().describe("Filter by bank document ID"),
      dateFrom: z.string().optional().describe("Filter from date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().optional().describe("Filter till date (DD.MM.YYYY or YYYY-MM-DD)"),
      companyName: z.string().optional().describe("Filter by company name"),
      lastChanges: z.string().optional().describe("Filter by last changes date"),
    },
    async (params) => {
      try {
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listBankRequest", NS.lst, "lst:requestBank", (req) => applyFilter(req, params));
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Bank documents", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_bank",
    description:
      "Create a bank document (receipt or expense) in POHODA, optionally liquidating (paying) invoices/receivables/commitments by number or extId. This is how a bank movement pairs with an invoice.",
    kind: "create",
    agenda: "bank",
    schema: {
      bankType: bankTypeEnum.describe("receipt = příjem, expense = výdej"),
      account: refSchema.optional().describe("Bank account (ids from settings); user default when omitted"),
      number: z.string().max(32).optional().describe("Requested document number"),
      statementNumber: z.string().max(10).optional().describe("Statement + movement number (max 10 chars)"),
      symVar: z.string().max(20).optional().describe("Variable symbol of the movement"),
      symConst: z.string().max(4).optional(),
      symSpec: z.string().max(16).optional(),
      symPar: z.string().max(20).optional(),
      dateStatement: z.string().describe("Statement date (DD.MM.YYYY or YYYY-MM-DD)"),
      datePayment: z.string().optional().describe("Payment date (defaults to statement date)"),
      accounting: accountingSchema.optional(),
      classificationVAT: classificationVATSchema.optional(),
      text: z.string().max(240).describe("Document text"),
      partner: partnerSchema.optional(),
      centre: refSchema.optional(),
      activity: refSchema.optional(),
      contract: refSchema.optional(),
      foreignCurrency: foreignCurrencySchema.optional(),
      note: z.string().optional(),
      intNote: z.string().optional(),
      extIdText: z.string().optional(),
      items: z.array(bankItemSchema).optional().describe("Free items (text lines) — use for movements that pay no document"),
      liquidations: z.array(liquidationSchema).optional().describe("Documents this movement pays (likvidace): agenda + number/extId + amount"),
    },
    summary: (p) => `bank ${p.bankType} ${p.dateStatement} VS ${p.symVar ?? "-"} ${p.liquidations?.length ? `pays ${p.liquidations.map((l) => l.sourceDocument.number ?? l.sourceDocument.extId ?? l.sourceDocument.id).join(",")}` : ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `bank ${p.bankType} ${p.symVar ?? ""}`.trim() }, ids, (item) => {
        const bank = item.ele(NS.bnk, "bnk:bank").att("version", "2.0");
        const header = bank.ele(NS.bnk, "bnk:bankHeader");
        addExtId(header, NS.bnk, "bnk", ids.extIds, c.config.extSystem, p.extIdText);
        header.ele(NS.bnk, "bnk:bankType").txt(p.bankType);
        if (p.account) addRef(header, NS.bnk, "bnk:account", p.account);
        if (p.number) addNumberRequested(header, NS.bnk, "bnk", p.number);
        addText(header, NS.bnk, "bnk:statementNumber", p.statementNumber);
        addText(header, NS.bnk, "bnk:symVar", p.symVar);
        addDate(header, NS.bnk, "bnk:dateStatement", p.dateStatement);
        addDate(header, NS.bnk, "bnk:datePayment", p.datePayment);
        if (p.accounting) addAccounting(header, NS.bnk, "bnk", p.accounting);
        if (p.classificationVAT) addClassificationVAT(header, NS.bnk, "bnk", p.classificationVAT);
        addText(header, NS.bnk, "bnk:text", p.text);
        if (hasPartner(p.partner)) addPartnerIdentity(header, NS.bnk, "bnk", p.partner, c.config.extSystem);
        addText(header, NS.bnk, "bnk:symConst", p.symConst);
        addText(header, NS.bnk, "bnk:symSpec", p.symSpec);
        addText(header, NS.bnk, "bnk:symPar", p.symPar);
        if (p.centre) addRef(header, NS.bnk, "bnk:centre", p.centre);
        if (p.activity) addRef(header, NS.bnk, "bnk:activity", p.activity);
        if (p.contract) addRef(header, NS.bnk, "bnk:contract", p.contract);
        addText(header, NS.bnk, "bnk:note", p.note);
        addText(header, NS.bnk, "bnk:intNote", p.intNote);

        if (p.items?.length || p.liquidations?.length) {
          const detail = bank.ele(NS.bnk, "bnk:bankDetail");
          for (const it of p.items ?? []) {
            const el = detail.ele(NS.bnk, "bnk:bankItem");
            el.ele(NS.bnk, "bnk:text").txt(it.text);
            el.ele(NS.bnk, "bnk:quantity").txt(String(it.quantity));
            el.ele(NS.bnk, "bnk:payVAT").txt(it.payVAT ? "true" : "false");
            el.ele(NS.bnk, "bnk:rateVAT").txt(it.rateVAT);
            el.ele(NS.bnk, p.foreignCurrency ? "bnk:foreignCurrency" : "bnk:homeCurrency").ele(NS.typ, "typ:unitPrice").txt(money(it.unitPrice));
            if (it.accounting) addAccounting(el, NS.bnk, "bnk", it.accounting);
            if (it.classificationVAT) addClassificationVAT(el, NS.bnk, "bnk", it.classificationVAT);
            if (it.centre) addRef(el, NS.bnk, "bnk:centre", it.centre);
            if (it.activity) addRef(el, NS.bnk, "bnk:activity", it.activity);
            if (it.contract) addRef(el, NS.bnk, "bnk:contract", it.contract);
          }
          for (const liq of p.liquidations ?? []) addLiquidationItem(detail, NS.bnk, "bnk", "bankLiquidationItem", liq, c.config.extSystem, "bank");
        }
        if (p.foreignCurrency) addForeignCurrency(bank.ele(NS.bnk, "bnk:bankSummary"), NS.bnk, "bnk", p.foreignCurrency);
      }),
  });
}
