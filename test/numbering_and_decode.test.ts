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
