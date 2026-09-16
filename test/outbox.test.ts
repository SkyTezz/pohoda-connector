import { describe, expect, it } from "vitest";
import { AGENT, HUMAN, SERVICE, errorResponse, harness, okResponse, parseToolJson } from "./helpers.js";

const invoiceArgs = {
  invoiceType: "issuedInvoice",
  number: "2026000001",
  date: "2026-09-16",
  dateTax: "2026-09-16",
  text: "Faktura 2026000001",
  accounting: { ids: "3Fv" },
  classificationVAT: { ids: "UD" },
  paymentType: { type: "draft" },
  partner: { company: "Zákazník s.r.o.", ico: "12345678", city: "Praha", linkToAddress: true },
  items: [{ text: "10 Kč 1993", quantity: 1, unitPrice: 1290, payVAT: true, rateVAT: "none", classificationVAT: { ids: "UDobch" } }],
  idempotencyKey: "order-invoice:2026000001:r1",
  reason: "daily close",
};

describe("approval write gate", () => {
  it("agent proposes; nothing is sent; ids are deterministic", async () => {
    const h = await harness();
    const result = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    expect(result.outcome).toBe("proposed");
    expect(result.state).toBe("proposed");
    expect(result.datapackId).toBe("TEST-order-invoice:2026000001:r1");
    expect(h.client.sent).toHaveLength(0);

    const proposal = await h.outbox.get(result.proposalId as number);
    expect(proposal?.xml).toContain('id="TEST-order-invoice:2026000001:r1"');
    expect(proposal?.xml).toContain('<dat:dataPackItem id="order-invoice:2026000001:r1"');
    expect(proposal?.xml).toContain("<typ:ids>order-invoice:2026000001:r1</typ:ids><typ:exSystemName>TEST</typ:exSystemName>");
    expect(proposal?.xml).toContain('<typ:numberRequested checkDuplicity="true">2026000001</typ:numberRequested>');
    expect(proposal?.xml).toContain("<inv:accounting><typ:ids>3Fv</typ:ids></inv:accounting>");
    expect(proposal?.xml).toContain("<inv:classificationVAT><typ:ids>UDobch</typ:ids></inv:classificationVAT>");
    expect(proposal?.xml).toContain("<inv:paymentType><typ:paymentType>draft</typ:paymentType></inv:paymentType>");
    expect(proposal?.xml).toContain('<typ:address linkToAddress="true">');
  });

  it("the same call twice yields the same proposal", async () => {
    const h = await harness();
    const first = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    const second = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    expect(second.outcome).toBe("already_proposed");
    expect(second.proposalId).toBe(first.proposalId);
    expect(await h.outbox.list({})).toHaveLength(1);
  });

  it("agents and service tokens cannot approve; humans can", async () => {
    const h = await harness();
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    const denied = await h.registryFor(AGENT).call("pohoda_proposal_approve", { id: proposalId });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/requires a human/);
    const deniedService = await h.registryFor(SERVICE).call("pohoda_proposal_approve", { id: proposalId });
    expect(deniedService.isError).toBe(true);

    const approved = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId, note: "ok" }));
    expect(approved.state).toBe("approved");
    expect(h.client.sent).toHaveLength(0);
  });

  it("send transmits the frozen XML with duplicity check and records POHODA's id", async () => {
    const h = await harness();
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId });
    h.client.queue.push(okResponse("order-invoice:2026000001:r1", 4711));
    const sent = parseToolJson(await h.registryFor(SERVICE).call("pohoda_proposal_send", { id: proposalId }));
    expect(sent.state).toBe("sent");
    expect(sent.pohodaId).toBe(4711);
    expect(h.client.sent).toHaveLength(1);
    expect(h.client.sent[0].options?.checkDuplicity).toBe(true);
    expect(h.client.sent[0].options?.instance).toBe("TEST-order-invoice:2026000001:r1");
    const events = await h.outbox.events(proposalId as number);
    expect(events.map((e) => e.toState)).toEqual(["proposed", "approved", "sending", "sent"]);
  });

  it("auto-send on approve sends immediately", async () => {
    const h = await harness({ autoSendOnApprove: true });
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    h.client.queue.push(okResponse("order-invoice:2026000001:r1"));
    const approved = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId }));
    expect(approved.state).toBe("sent");
  });

  it("transport failure → failed, replay re-sends identical XML; POHODA duplicate → sent", async () => {
    const h = await harness();
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId });
    h.client.queue.push(new Error("POHODA mServer did not respond within 1s."));
    const failed = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_send", { id: proposalId }));
    expect(failed.state).toBe("failed");
    expect(failed.attempts).toBe(1);

    h.client.queue.push(errorResponse("order-invoice:2026000001:r1", "Duplicitní doklad: dataPackItem id již byl importován"));
    const replayed = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_send", { id: proposalId }));
    expect(replayed.state).toBe("sent");
    expect(replayed.duplicate).toBe(true);
    expect(h.client.sent[0].xml).toBe(h.client.sent[1].xml);
  });

  it("POHODA refusal → refused with the note kept", async () => {
    const h = await harness();
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId });
    h.client.queue.push(errorResponse("order-invoice:2026000001:r1", "Členění DPH UDobch neexistuje"));
    const refused = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_send", { id: proposalId }));
    expect(refused.state).toBe("refused");
    expect(refused.error).toMatch(/UDobch/);
    const again = await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId });
    expect(again.isError).toBe(true);
  });

  it("rejection needs a human and a reason", async () => {
    const h = await harness();
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    const denied = await h.registryFor(AGENT).call("pohoda_proposal_reject", { id: proposalId, reason: "x" });
    expect(denied.isError).toBe(true);
    const rejected = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_reject", { id: proposalId, reason: "wrong VAT" }));
    expect(rejected.state).toBe("rejected");
  });

  it("delete tools are disabled by default", async () => {
    const h = await harness();
    const result = await h.registryFor(HUMAN).call("pohoda_delete_invoice", { id: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/storno/);
    expect(await h.outbox.list({})).toHaveLength(0);
  });

  it("sandbox lets an agent approve", async () => {
    const h = await harness({ sandbox: true });
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs));
    const approved = parseToolJson(await h.registryFor(AGENT).call("pohoda_proposal_approve", { id: proposalId }));
    expect(approved.state).toBe("approved");
  });

  it("direct mode sends immediately with deterministic ids", async () => {
    const h = await harness({ writeMode: "direct" });
    h.client.queue.push(okResponse("order-invoice:2026000001:r1", 99));
    const result = await h.registryFor(AGENT).call("pohoda_create_invoice", invoiceArgs);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/ID: 99/);
    expect(h.client.sent[0].xml).toContain('id="TEST-order-invoice:2026000001:r1"');
  });
});
