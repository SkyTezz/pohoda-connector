import { z } from "zod";
import type { XMLBuilder } from "./builder.js";
import { NS } from "./namespaces.js";
import { toIsoDate } from "../core/shared.js";

/**
 * Shared XML fragments for the document agendas, named after the XSD types
 * they produce (type.xsd). Element names come from the schema files
 * downloaded from stormware.cz/xml/schema/version_2/, not from memory.
 */

export const vatRateEnum = z.enum(["none", "low", "high", "third", "historyHigh", "historyLow", "historyThird"]);

export const paymentTypeEnum = z.enum(["draft", "cash", "postal", "delivery", "creditcard", "advance", "encashment", "cheque", "compensation"]);

export const liquidatedAgendaEnum = z.enum([
  "issuedInvoice",
  "receivedInvoice",
  "receivable",
  "commitment",
  "issuedAdvanceInvoice",
  "receivedAdvanceInvoice",
]);

export const roundingDocumentEnum = z.enum([
  "none",
  "math2one",
  "math2half",
  "math2tenth",
  "math5cent",
  "up2one",
  "up2half",
  "up2tenth",
  "down2one",
  "down2half",
  "down2tenth",
]);

/** typ:refType — reference a list item by numeric id or by its short code (`ids`). */
export const refSchema = z
  .object({
    id: z.number().int().optional().describe("Numeric POHODA id"),
    ids: z.string().max(19).optional().describe("Short code (IDS) as shown in POHODA lists"),
  })
  .refine((r) => r.id != null || r.ids != null, { message: "give id or ids" });
export type Ref = z.infer<typeof refSchema>;

export const accountingSchema = z
  .object({
    id: z.number().int().optional(),
    ids: z.string().max(19).optional().describe("Pre-accounting code (předkontace), e.g. 3Fv"),
    type: z.enum(["withoutAccounting"]).optional().describe("withoutAccounting = Bez zaúčtování"),
  })
  .refine((a) => a.id != null || a.ids != null || a.type != null, { message: "give id, ids or type" });
export type Accounting = z.infer<typeof accountingSchema>;

export const classificationVATSchema = z
  .object({
    id: z.number().int().optional(),
    ids: z.string().max(19).optional().describe("VAT classification code (členění DPH), e.g. UD, UN, UDobch, UKosv"),
    type: z.enum(["inland", "nonSubsume"]).optional().describe("inland = tuzemské plnění, nonSubsume = nezahrnovat do DPH"),
  })
  .refine((c) => c.id != null || c.ids != null || c.type != null, { message: "give id, ids or type" });
export type ClassificationVAT = z.infer<typeof classificationVATSchema>;

export const paymentSchema = z
  .object({
    id: z.number().int().optional(),
    ids: z.string().max(19).optional().describe("Payment form code as listed in POHODA"),
    type: paymentTypeEnum.optional().describe("draft=převod, cash=hotově, delivery=dobírka, creditcard, advance, ..."),
  })
  .refine((p) => p.id != null || p.ids != null || p.type != null, { message: "give id, ids or type" });
export type Payment = z.infer<typeof paymentSchema>;

export const partnerSchema = z.object({
  extId: z.string().max(64).optional().describe("Address book extId (ids) to bind the document to an existing address"),
  company: z.string().max(96).optional().describe("Company name (Firma)"),
  division: z.string().max(32).optional(),
  name: z.string().max(32).optional().describe("Contact person / name for private persons"),
  street: z.string().max(64).optional(),
  city: z.string().max(45).optional(),
  zip: z.string().max(15).optional(),
  ico: z.string().max(15).optional(),
  dic: z.string().max(18).optional(),
  icDph: z.string().max(18).optional().describe("SK VAT id"),
  country: z.string().max(19).optional().describe("Country IDS, e.g. CZ, SK, DE"),
  phone: z.string().max(40).optional(),
  mobilPhone: z.string().max(24).optional(),
  email: z.string().max(98).optional(),
  linkToAddress: z.boolean().optional().describe("true = bind to the address book (ico → dic → icDph → company → name, single match only)"),
});
export type Partner = z.infer<typeof partnerSchema>;

export const sourceDocumentSchema = z
  .object({
    id: z.number().int().optional().describe("POHODA id of the source document"),
    number: z.string().max(32).optional().describe("Document number as printed in POHODA"),
    extId: z.string().max(64).optional().describe("extId (ids) the document was imported with"),
  })
  .refine((s) => s.id != null || s.number != null || s.extId != null, { message: "give id, number or extId" });
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const liquidationSchema = z.object({
  sourceAgenda: liquidatedAgendaEnum.describe("Agenda of the document being paid"),
  sourceDocument: sourceDocumentSchema,
  amount: z.number().describe("Amount to liquidate in home currency"),
  rate: z.number().optional().describe("Liquidation exchange rate for foreign-currency documents"),
  rateVAT: vatRateEnum.optional().describe("VAT rate of the liquidation item (default none)"),
});
export type Liquidation = z.infer<typeof liquidationSchema>;

export const foreignCurrencySchema = z.object({
  currency: z.string().max(19).describe("Currency IDS, e.g. EUR"),
  rate: z.number().describe("Exchange rate"),
  amount: z.number().int().min(1).optional().describe("Rate quantity (1 or 100), default 1"),
});
export type ForeignCurrency = z.infer<typeof foreignCurrencySchema>;

export function addExtId(parent: XMLBuilder, ns: string, prefix: string, ids: string, exSystemName: string, exSystemText?: string): void {
  const el = parent.ele(ns, `${prefix}:extId`);
  el.ele(NS.typ, "typ:ids").txt(ids);
  el.ele(NS.typ, "typ:exSystemName").txt(exSystemName);
  if (exSystemText) el.ele(NS.typ, "typ:exSystemText").txt(exSystemText);
}

export function addRef(parent: XMLBuilder, ns: string, tag: string, ref: Ref): void {
  const el = parent.ele(ns, tag);
  if (ref.id != null) el.ele(NS.typ, "typ:id").txt(String(ref.id));
  if (ref.ids != null) el.ele(NS.typ, "typ:ids").txt(ref.ids);
}

export function addAccounting(parent: XMLBuilder, ns: string, prefix: string, accounting: Accounting): void {
  const el = parent.ele(ns, `${prefix}:accounting`);
  if (accounting.id != null) el.ele(NS.typ, "typ:id").txt(String(accounting.id));
  if (accounting.ids != null) el.ele(NS.typ, "typ:ids").txt(accounting.ids);
  if (accounting.type != null) el.ele(NS.typ, "typ:accountingType").txt(accounting.type);
}

export function addClassificationVAT(parent: XMLBuilder, ns: string, prefix: string, classification: ClassificationVAT): void {
  const el = parent.ele(ns, `${prefix}:classificationVAT`);
  if (classification.id != null) el.ele(NS.typ, "typ:id").txt(String(classification.id));
  if (classification.ids != null) el.ele(NS.typ, "typ:ids").txt(classification.ids);
  if (classification.type != null) el.ele(NS.typ, "typ:classificationVATType").txt(classification.type);
}

export function addPaymentType(parent: XMLBuilder, ns: string, prefix: string, payment: Payment): void {
  const el = parent.ele(ns, `${prefix}:paymentType`);
  if (payment.id != null) el.ele(NS.typ, "typ:id").txt(String(payment.id));
  if (payment.ids != null) el.ele(NS.typ, "typ:ids").txt(payment.ids);
  if (payment.type != null) el.ele(NS.typ, "typ:paymentType").txt(payment.type);
}

/** typ:numberType with numberRequested — the caller's own document number, duplicity-checked by POHODA. */
export function addNumberRequested(parent: XMLBuilder, ns: string, prefix: string, number: string, checkDuplicity = true): void {
  parent
    .ele(ns, `${prefix}:number`)
    .ele(NS.typ, "typ:numberRequested")
    .att("checkDuplicity", checkDuplicity ? "true" : "false")
    .txt(number);
}

export function hasPartner(partner: Partner | undefined): partner is Partner {
  return partner != null && Object.values(partner).some((v) => v != null && v !== "");
}

export function addPartnerIdentity(parent: XMLBuilder, ns: string, prefix: string, partner: Partner, exSystemName: string): void {
  const identity = parent.ele(ns, `${prefix}:partnerIdentity`);
  if (partner.extId) {
    const ext = identity.ele(NS.typ, "typ:extId");
    ext.ele(NS.typ, "typ:ids").txt(partner.extId);
    ext.ele(NS.typ, "typ:exSystemName").txt(exSystemName);
  }
  const addr = identity.ele(NS.typ, "typ:address");
  if (partner.linkToAddress != null) addr.att("linkToAddress", partner.linkToAddress ? "true" : "false");
  if (partner.company) addr.ele(NS.typ, "typ:company").txt(partner.company);
  if (partner.division) addr.ele(NS.typ, "typ:division").txt(partner.division);
  if (partner.name) addr.ele(NS.typ, "typ:name").txt(partner.name);
  if (partner.city) addr.ele(NS.typ, "typ:city").txt(partner.city);
  if (partner.street) addr.ele(NS.typ, "typ:street").txt(partner.street);
  if (partner.zip) addr.ele(NS.typ, "typ:zip").txt(partner.zip);
  if (partner.ico) addr.ele(NS.typ, "typ:ico").txt(partner.ico);
  if (partner.dic) addr.ele(NS.typ, "typ:dic").txt(partner.dic);
  if (partner.icDph) addr.ele(NS.typ, "typ:icDph").txt(partner.icDph);
  if (partner.country) addr.ele(NS.typ, "typ:country").ele(NS.typ, "typ:ids").txt(partner.country);
  if (partner.phone) addr.ele(NS.typ, "typ:phone").txt(partner.phone);
  if (partner.mobilPhone) addr.ele(NS.typ, "typ:mobilPhone").txt(partner.mobilPhone);
  if (partner.email) addr.ele(NS.typ, "typ:email").txt(partner.email);
}

export function addSourceDocument(parent: XMLBuilder, ns: string, tag: string, source: SourceDocument, exSystemName: string): void {
  const el = parent.ele(ns, tag);
  if (source.id != null) el.ele(NS.typ, "typ:id").txt(String(source.id));
  if (source.extId != null) {
    const ext = el.ele(NS.typ, "typ:extId");
    ext.ele(NS.typ, "typ:ids").txt(source.extId);
    ext.ele(NS.typ, "typ:exSystemName").txt(exSystemName);
  }
  if (source.number != null) el.ele(NS.typ, "typ:number").txt(source.number);
}

/**
 * Bank/voucher liquidation of a receivable or payable:
 *   <bnk:bankLiquidationItem><bnk:settingsLiquidation>…</bnk:settingsLiquidation><bnk:liquidationItem>…
 * Element names per bank.xsd / voucher.xsd (`settingsLiquidationType`, `liquidationItemType`).
 */
export function addLiquidationItem(
  parent: XMLBuilder,
  ns: string,
  prefix: string,
  itemTag: string,
  liquidation: Liquidation,
  exSystemName: string,
  variant: "bank" | "voucher",
): void {
  const item = parent.ele(ns, `${prefix}:${itemTag}`);
  const settings = item.ele(ns, `${prefix}:settingsLiquidation`);
  settings.ele(ns, `${prefix}:sourceAgenda`).txt(liquidation.sourceAgenda);
  addSourceDocument(settings, ns, `${prefix}:sourceDocument`, liquidation.sourceDocument, exSystemName);
  settings.ele(ns, `${prefix}:liquidationPrice`).txt(money(liquidation.amount));
  if (liquidation.rate != null) settings.ele(ns, `${prefix}:liquidationRate`).txt(String(liquidation.rate));
  const li = item.ele(ns, `${prefix}:liquidationItem`);
  li.ele(ns, `${prefix}:quantity`).txt("1");
  li.ele(ns, `${prefix}:payVAT`).txt("false");
  li.ele(ns, `${prefix}:rateVAT`).txt(liquidation.rateVAT ?? "none");
  // bank.xsd liquidationItemType carries homeCurrency; voucher.xsd's does not (the
  // amount lives in settingsLiquidation/liquidationPrice only).
  if (variant === "bank") li.ele(ns, `${prefix}:homeCurrency`).ele(NS.typ, "typ:unitPrice").txt(money(liquidation.amount));
}

export function addForeignCurrency(parent: XMLBuilder, ns: string, prefix: string, fc: ForeignCurrency, priceSum?: number): void {
  const el = parent.ele(ns, `${prefix}:foreignCurrency`);
  el.ele(NS.typ, "typ:currency").ele(NS.typ, "typ:ids").txt(fc.currency);
  el.ele(NS.typ, "typ:rate").txt(String(fc.rate));
  el.ele(NS.typ, "typ:amount").txt(String(fc.amount ?? 1));
  if (priceSum != null) el.ele(NS.typ, "typ:priceSum").txt(money(priceSum));
}

export function addDate(parent: XMLBuilder, ns: string, tag: string, value: string | undefined): void {
  if (value) parent.ele(ns, tag).txt(toIsoDate(value));
}

export function addText(parent: XMLBuilder, ns: string, tag: string, value: string | undefined): void {
  if (value != null && value !== "") parent.ele(ns, tag).txt(value);
}

/** POHODA takes decimals with a dot; two places are enough for CZK/EUR amounts, quantities keep what they carry. */
export function money(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
