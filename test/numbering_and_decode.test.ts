import { deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeBody } from "../src/client.js";
import { AGENT, harness, parseToolJson } from "./helpers.js";

async function proposedXml(args: Record<string, unknown>): Promise<string> {
  const h = await harness();
  const result = await h.registryFor(AGENT).call("pohoda_create_invoice", args);
  const { proposalId } = parseToolJson(result);
  if (result.isError) throw new Error(result.content[0].text);
  return (await h.outbox.get(proposalId as number))!.xml;
}

const RECEIVED = { invoiceType: "receivedInvoice", date: "2026-05-24", text: "Dopravné a poplatky", totals: { priceNone: "3813.18" } };

describe("invoice number series", () => {
  it("asks POHODA for the next number of the series", async () => {
    const xml = await proposedXml({ ...RECEIVED, numberSeries: "2611", idempotencyKey: "series-1" });
    expect(xml).toContain("<inv:number><typ:ids>2611</typ:ids></inv:number>");
    expect(xml).not.toContain("numberRequested");
  });

  it("refuses a requested number together with a series", async () => {
    const h = await harness();
    const result = await h.registryFor(AGENT).call("pohoda_create_invoice", { ...RECEIVED, number: "261100040", numberSeries: "2611", idempotencyKey: "series-2" });
    expect(JSON.stringify(result)).toContain("give number or numberSeries, not both");
  });
});

describe("mServer response body", () => {
  const xml = Buffer.from('<?xml version="1.0"?><rsp:responsePack state="ok"/>');

  it("keeps a body fetch already decompressed although Content-Encoding still says so", () => {
    expect(decodeBody("deflate", xml).toString()).toBe(xml.toString());
    expect(decodeBody("gzip", xml).toString()).toBe(xml.toString());
  });

  it("still decompresses a body that is really compressed", () => {
    expect(decodeBody("gzip", gzipSync(xml)).toString()).toBe(xml.toString());
    expect(decodeBody("deflate", deflateSync(xml)).toString()).toBe(xml.toString());
  });
});

describe("document refused inside an ok pack item", () => {
  it("is a failure with POHODA's error note", async () => {
    const { parseResponse, extractImportResult } = await import("../src/xml/parser.js");
    const xml = `<?xml version="1.0"?><rsp:responsePack version="2.0" state="ok" xmlns:rsp="r" xmlns:inv="i" xmlns:rdc="d">
<rsp:responsePackItem version="2.0" id="k" state="ok"><inv:invoiceResponse version="2.0" state="error"><rdc:importDetails>
<rdc:detail><rdc:state>error</rdc:state><rdc:errno>114</rdc:errno><rdc:note>Neni zadano cislo dokladu.</rdc:note></rdc:detail>
<rdc:detail><rdc:state>warning</rdc:state><rdc:errno>606</rdc:errno><rdc:note>Datum neni z obdobi.</rdc:note></rdc:detail>
</rdc:importDetails><rdc:producedDetails><rdc:id>0</rdc:id></rdc:producedDetails></inv:invoiceResponse></rsp:responsePackItem></rsp:responsePack>`;
    const result = extractImportResult(parseResponse(xml));
    expect(result.success).toBe(false);
    expect(result.message).toContain("errno 114");
    expect(result.message).not.toContain("errno 606");
  });

  it("a document imported with warnings is still a success", async () => {
    const { parseResponse, extractImportResult } = await import("../src/xml/parser.js");
    const xml = `<?xml version="1.0"?><rsp:responsePack version="2.0" state="ok" xmlns:rsp="r" xmlns:inv="i" xmlns:rdc="d">
<rsp:responsePackItem version="2.0" id="k" state="ok"><inv:invoiceResponse version="2.0" state="warning"><rdc:producedDetails><rdc:id>389</rdc:id></rdc:producedDetails></inv:invoiceResponse></rsp:responsePackItem></rsp:responsePack>`;
    const result = extractImportResult(parseResponse(xml));
    expect(result.success).toBe(true);
    expect(result.producedId).toBe(389);
  });
});
