import { describe, expect, it } from "vitest";
import { AGENT, harness, parseToolJson } from "./helpers.js";

async function proposedXml(tool: string, args: Record<string, unknown>): Promise<string> {
  const h = await harness();
  const result = await h.registryFor(AGENT).call(tool, args);
  if (result.isError) throw new Error(result.content[0].text);
  const { proposalId } = parseToolJson(result);
  return (await h.outbox.get(proposalId as number))!.xml;
}

describe("document XML", () => {
  it("bank receipt liquidates an invoice by number", async () => {
    const xml = await proposedXml("pohoda_create_bank", {
      bankType: "receipt",
      account: { ids: "KB" },
      dateStatement: "16.09.2026",
      symVar: "2026000001",
      text: "Platba 2026000001",
      liquidations: [{ sourceAgenda: "issuedInvoice", sourceDocument: { number: "2026000001" }, amount: 1290 }],
      idempotencyKey: "bank:18342",
    });
    expect(xml).toContain("<bnk:bankType>receipt</bnk:bankType>");
    expect(xml).toContain("<bnk:account><typ:ids>KB</typ:ids></bnk:account>");
    expect(xml).toContain("<bnk:dateStatement>2026-09-16</bnk:dateStatement>");
    expect(xml).toContain(
      "<bnk:bankLiquidationItem><bnk:settingsLiquidation><bnk:sourceAgenda>issuedInvoice</bnk:sourceAgenda><bnk:sourceDocument><typ:number>2026000001</typ:number></bnk:sourceDocument><bnk:liquidationPrice>1290</bnk:liquidationPrice></bnk:settingsLiquidation><bnk:liquidationItem><bnk:quantity>1</bnk:quantity><bnk:payVAT>false</bnk:payVAT><bnk:rateVAT>none</bnk:rateVAT><bnk:homeCurrency><typ:unitPrice>1290</typ:unitPrice></bnk:homeCurrency></bnk:liquidationItem></bnk:bankLiquidationItem>",
    );
  });

  it("cash voucher carries cash register, per-line VAT classification and no homeCurrency on liquidation items", async () => {
    const xml = await proposedXml("pohoda_create_voucher", {
      voucherType: "receipt",
      cashAccount: { ids: "POKL1" },
      date: "2026-09-16",
      text: "Prodej UCT-2026-0001",
      items: [
        { text: "Zlatá mince §92", unitPrice: 25000, payVAT: true, rateVAT: "none", classificationVAT: { ids: "UKosv" } },
        { text: "Kapsle", unitPrice: 12.1, payVAT: true, rateVAT: "high", classificationVAT: { ids: "UD" } },
      ],
      liquidations: [{ sourceAgenda: "issuedInvoice", sourceDocument: { extId: "order-invoice:2026000001:r1" }, amount: 100 }],
      idempotencyKey: "pos:UCT-2026-0001",
    });
    expect(xml).toContain("<vch:cashAccount><typ:ids>POKL1</typ:ids></vch:cashAccount>");
    expect(xml).toContain("<vch:classificationVAT><typ:ids>UKosv</typ:ids></vch:classificationVAT>");
    expect(xml).toContain("<typ:unitPrice>12.10</typ:unitPrice>");
    expect(xml).toContain("<vch:sourceDocument><typ:extId><typ:ids>order-invoice:2026000001:r1</typ:ids><typ:exSystemName>TEST</typ:exSystemName></typ:extId></vch:sourceDocument>");
    expect(xml).toContain("<vch:liquidationItem><vch:quantity>1</vch:quantity><vch:payVAT>false</vch:payVAT><vch:rateVAT>none</vch:rateVAT></vch:liquidationItem>");
  });

  it("internal document expresses the §90 margin scheme with two classifications", async () => {
    const xml = await proposedXml("pohoda_create_internal_doc", {
      date: "2026-09-30",
      text: "§90 přirážka 09/2026",
      accounting: { ids: "ID" },
      items: [
        { text: "Plnění bez přirážky", unitPrice: 100000, rateVAT: "none", classificationVAT: { ids: "UDobch" } },
        { text: "Přirážka", unitPrice: 12100, payVAT: true, rateVAT: "high", classificationVAT: { ids: "UD" } },
      ],
      idempotencyKey: "margin:2026-09",
    });
    expect(xml).toContain("<int:intDocHeader><int:extId><typ:ids>margin:2026-09</typ:ids>");
    expect(xml).toContain("<int:classificationVAT><typ:ids>UDobch</typ:ids></int:classificationVAT>");
    expect(xml).toContain("<int:payVAT>true</int:payVAT><int:rateVAT>high</int:rateVAT>");
  });

  it("invoice deducts an advance invoice and keeps EUR prices in foreignCurrency", async () => {
    const xml = await proposedXml("pohoda_create_invoice", {
      invoiceType: "issuedInvoice",
      number: "2026003001",
      date: "2026-09-16",
      text: "Faktura EUR",
      foreignCurrency: { currency: "EUR", rate: 24.5 },
      items: [{ text: "Mince", unitPrice: 200, rateVAT: "none" }],
      advancePayments: [{ sourceDocument: { number: "2026003001" }, amount: 200 }],
      idempotencyKey: "order-invoice:2026003001:r1",
    });
    expect(xml).toContain("<inv:foreignCurrency><typ:unitPrice>200</typ:unitPrice></inv:foreignCurrency>");
    expect(xml).toContain("<inv:invoiceAdvancePaymentItem><inv:sourceDocument><typ:number>2026003001</typ:number></inv:sourceDocument>");
    expect(xml).toContain("<inv:invoiceSummary><inv:foreignCurrency><typ:currency><typ:ids>EUR</typ:ids></typ:currency><typ:rate>24.5</typ:rate><typ:amount>1</typ:amount></inv:foreignCurrency></inv:invoiceSummary>");
  });

  it("storno and corrective documents reference the source document", async () => {
    const storno = await proposedXml("pohoda_cancel_invoice", { sourceDocument: { number: "2026000001" }, idempotencyKey: "storno:2026000001" });
    expect(storno).toContain("<inv:cancelDocument><typ:sourceDocument><typ:number>2026000001</typ:number></typ:sourceDocument></inv:cancelDocument>");
    const corrective = await proposedXml("pohoda_create_corrective_invoice", {
      sourceDocument: { extId: "order-invoice:2026000001:r1" },
      date: "2026-09-20",
      text: "Opravný daňový doklad",
      items: [{ text: "Vrácení", quantity: -1, unitPrice: 1290, payVAT: true, rateVAT: "none" }],
      idempotencyKey: "credit:2026000001:1",
    });
    expect(corrective).toContain("<inv:correctiveDocument><typ:sourceDocument><typ:extId>");
    expect(corrective).toContain("<inv:invoiceType>issuedCorrectiveTax</inv:invoiceType>");
    expect(corrective).toContain("<inv:quantity>-1</inv:quantity>");
  });

  it("address update/delete target by extId through the filter", async () => {
    const xml = await proposedXml("pohoda_update_address", { target: { extId: "client:4711" }, email: "new@example.com", idempotencyKey: "client:4711:r2" });
    expect(xml).toContain("<adb:actionType><adb:update><ftr:filter><ftr:extId><typ:ids>client:4711</typ:ids><typ:exSystemName>TEST</typ:exSystemName></ftr:extId></ftr:filter></adb:update></adb:actionType>");
    expect(xml).toContain("<adb:email>new@example.com</adb:email>");
  });
});
