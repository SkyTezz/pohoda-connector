import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { SqliteOutboxStore } from "../src/outbox/sqlite_store.js";
import { AGENT, HUMAN, harness, okResponse, parseToolJson } from "./helpers.js";

const WITH_MSERVER = "11111111";
const WAITING = "22222222";
const units = [
  { ico: WITH_MSERVER, name: "First s.r.o.", mserver: { url: "http://pohoda.test:444", username: "u", password: "p", timeout: 1000, maxRetries: 0 } },
  { ico: WAITING, name: "Second a.s." },
];

const invoice = {
  invoiceType: "receivedInvoice",
  date: "2026-10-01",
  text: "Přeprava zásilek",
  accounting: { ids: "518" },
  classificationVAT: { ids: "PK" },
  partner: { company: "Dopravce s.r.o.", ico: "87654321" },
  items: [{ text: "Přeprava", quantity: 1, unitPrice: 100, payVAT: false, rateVAT: "high" }],
};

describe("several accounting units", () => {
  it("needs to be told which unit, and refuses one it does not serve", async () => {
    const reg = (await harness({ units })).registryFor(AGENT);
    const none = await reg.call("pohoda_create_invoice", invoice);
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/accountingUnit is required.*11111111, 22222222/);
    const unknown = await reg.call("pohoda_create_invoice", { ...invoice, accountingUnit: "99999999" });
    expect(unknown.content[0].text).toMatch(/unknown accounting unit "99999999"/);
  });

  it("builds the document for the unit of the call and sends it to that unit's mServer", async () => {
    const h = await harness({ units, autoSendOnApprove: true });
    const proposed = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", { ...invoice, accountingUnit: WITH_MSERVER, idempotencyKey: "rec:1" }));
    expect(proposed.accountingUnit).toBe(WITH_MSERVER);
    const stored = await h.outbox.get(proposed.proposalId as number);
    expect(stored?.unit).toBe(WITH_MSERVER);
    expect(stored?.xml).toContain(`ico="${WITH_MSERVER}"`);

    h.client.queue.push(okResponse("rec:1", 7, "261100001"));
    const approved = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposed.proposalId }));
    expect(approved.state).toBe("sent");
    expect(h.client.sent).toHaveLength(1);
  });

  it("queues documents of a unit whose mServer is not configured: approved, never sent, and says why", async () => {
    const h = await harness({ units, autoSendOnApprove: true });
    const proposed = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", { ...invoice, accountingUnit: WAITING, idempotencyKey: "rec:2" }));
    expect(proposed.outcome).toBe("proposed");
    expect((await h.outbox.get(proposed.proposalId as number))?.xml).toContain(`ico="${WAITING}"`);

    const approved = parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposed.proposalId }));
    expect(approved.state).toBe("approved");
    const send = await h.registryFor(HUMAN).call("pohoda_proposal_send", { id: proposed.proposalId });
    expect(send.isError).toBe(true);
    expect(send.content[0].text).toMatch(/mServer of accounting unit 22222222 is not configured/);
    expect((await h.outbox.get(proposed.proposalId as number))?.state).toBe("approved");
    expect(h.client.sent).toHaveLength(0);

    // reads through mServer for that unit fail the same loud way
    const status = await h.registryFor(AGENT).call("pohoda_status", { accountingUnit: WAITING });
    expect(status.content[0].text).toMatch(/mServer of accounting unit 22222222 is not configured/);
  });

  it("treats the same arguments for two units as two documents, and one key as one unit's", async () => {
    const reg = (await harness({ units })).registryFor(AGENT);
    const first = parseToolJson(await reg.call("pohoda_create_invoice", { ...invoice, accountingUnit: WITH_MSERVER }));
    const second = parseToolJson(await reg.call("pohoda_create_invoice", { ...invoice, accountingUnit: WAITING }));
    expect(second.outcome).toBe("proposed");
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(second.key).not.toBe(first.key);

    await reg.call("pohoda_create_invoice", { ...invoice, accountingUnit: WITH_MSERVER, idempotencyKey: "rec:3" });
    const clash = await reg.call("pohoda_create_invoice", { ...invoice, accountingUnit: WAITING, idempotencyKey: "rec:3" });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toMatch(/already belongs to a proposal of accounting unit 11111111/);
  });

  it("lists the queue per unit and reports the units it serves", async () => {
    const h = await harness({ units });
    const reg = h.registryFor(AGENT);
    await reg.call("pohoda_create_invoice", { ...invoice, accountingUnit: WAITING, idempotencyKey: "rec:4" });
    await reg.call("pohoda_create_invoice", { ...invoice, accountingUnit: WITH_MSERVER, idempotencyKey: "rec:5" });
    const queue = await reg.call("pohoda_proposals_list", { accountingUnit: WAITING });
    expect(queue.content[0].text).toContain("rec:4");
    expect(queue.content[0].text).not.toContain("rec:5");
    const info = parseToolJson(await reg.call("pohoda_connector_info", {}));
    expect(info.accountingUnits).toEqual([
      { ico: WITH_MSERVER, name: "First s.r.o.", mserver: true },
      { ico: WAITING, name: "Second a.s.", mserver: false },
    ]);
  });
});

describe("received invoice", () => {
  const received = {
    accountingUnit: WAITING,
    invoiceType: "receivedInvoice",
    symVar: "5010009010",
    originalDocument: "5010009010",
    date: "2026-10-01",
    dateTax: "2026-10-01",
    dateDue: "2026-10-15",
    dateApplicationVAT: "2026-10-01",
    accounting: { ids: "518" },
    classificationVAT: { ids: "PK" },
    text: "Přeprava zásilek",
    partner: { company: "Dopravce s.r.o.", ico: "87654321", dic: "CZ87654321" },
    paymentType: { type: "draft" },
    paymentAccount: { accountNo: "2000123456", bankCode: "2010" },
    idempotencyKey: "rec-inv:87654321:5010009010",
  };

  it("books a document without items from header totals, in schema order, with exact amounts and a link to the original", async () => {
    const h = await harness({ units });
    const proposed = parseToolJson(
      await h.registryFor(AGENT).call("pohoda_create_invoice", {
        ...received,
        totals: { priceHigh: "70.58", priceHighVAT: "14.82" },
        attachments: [{ name: "Originál faktury", url: "https://files.example/doc/41" }],
      }),
    );
    const xml = (await h.outbox.get(proposed.proposalId as number))!.xml;
    const order = ["inv:invoiceType", "inv:symVar", "inv:originalDocument", "inv:date", "inv:dateTax", "inv:dateDue", "inv:dateApplicationVAT", "inv:accounting", "inv:classificationVAT", "inv:text", "inv:partnerIdentity", "inv:paymentType", "inv:paymentAccount", "inv:invoiceSummary", "inv:attachments"];
    const positions = order.map((tag) => xml.indexOf(`<${tag}>`));
    expect(positions.every((p) => p >= 0), `missing: ${order.filter((_, i) => positions[i] < 0).join(", ")}`).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(xml).toContain("<inv:originalDocument>5010009010</inv:originalDocument>");
    expect(xml).toContain("<typ:accountNo>2000123456</typ:accountNo><typ:bankCode>2010</typ:bankCode>");
    expect(xml).toContain("<inv:homeCurrency><typ:priceHigh>70.58</typ:priceHigh><typ:priceHighVAT>14.82</typ:priceHighVAT></inv:homeCurrency>");
    expect(xml).toContain("<typ:urlAddress><typ:name>Originál faktury</typ:name><typ:url>https://files.example/doc/41</typ:url></typ:urlAddress>");
    expect(xml).not.toContain("<inv:invoiceDetail>");
  });

  it("splits a document over lines with their own pre-accounting, and refuses totals next to items", async () => {
    const reg = (await harness({ units })).registryFor(AGENT);
    const items = [
      { text: "Hrubé mzdy", quantity: 1, unitPrice: "116933.00", payVAT: false, rateVAT: "none", accounting: { ids: "8Oz" } },
      { text: "Zákonné pojištění", quantity: 1, unitPrice: "263135.00", payVAT: false, rateVAT: "none", accounting: { ids: "aOz" } },
    ];
    const h = await harness({ units });
    const proposed = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", { ...received, idempotencyKey: "split:1", items }));
    const xml = (await h.outbox.get(proposed.proposalId as number))!.xml;
    expect(xml.match(/<inv:invoiceItem>/g)).toHaveLength(2);
    expect(xml).toContain("<typ:unitPrice>116933.00</typ:unitPrice>");
    expect(xml).toMatch(/<inv:invoiceItem>.*?<typ:ids>8Oz<\/typ:ids>.*?<\/inv:invoiceItem>.*<typ:ids>aOz<\/typ:ids>/s);

    const both = await reg.call("pohoda_create_invoice", { ...received, idempotencyKey: "split:2", items, totals: { priceNone: "1" } });
    expect(both.content[0].text).toMatch(/either items or totals/);
    const sloppy = reg.call("pohoda_create_invoice", { ...received, idempotencyKey: "split:3", totals: { priceHigh: "70,58" } });
    await expect(sloppy).rejects.toThrow(/decimal number as text/);
  });
});

describe("accounting units in configuration", () => {
  it("reads POHODA_UNITS next to the single-unit variables and refuses malformed or repeated units", () => {
    const sql = { POHODA_SQL_SERVER: "s", POHODA_SQL_DATABASE: "StwPh_11111111_2025", POHODA_SQL_USER: "ro", POHODA_SQL_PASSWORD: "p" };
    const cfg = loadConfig({ ...sql, POHODA_UNITS: JSON.stringify({ [WAITING]: { name: "Second a.s." }, [WITH_MSERVER]: { mserver: { url: "http://h:444", username: "u", password: "p" } } }) });
    expect(cfg.units.map((u) => [u.ico, u.name, u.mserver?.url])).toEqual([
      [WITH_MSERVER, undefined, "http://h:444"],
      [WAITING, "Second a.s.", undefined],
    ]);
    expect(() => loadConfig({ ...sql, POHODA_UNITS: "{" })).toThrow(/not valid JSON/);
    expect(() => loadConfig({ ...sql, POHODA_UNITS: JSON.stringify({ abc: {} }) })).toThrow(/IČO must be 6-10 digits/);
    expect(() => loadConfig({ ...sql, POHODA_UNITS: JSON.stringify({ [WAITING]: { mserver: { url: "http://h:444" } } }) })).toThrow(/needs url, username and password/);
    const single = { POHODA_URL: "http://p:444", POHODA_USERNAME: "u", POHODA_PASSWORD: "p", POHODA_ICO: WAITING };
    expect(() => loadConfig({ ...single, POHODA_UNITS: JSON.stringify({ [WAITING]: {} }) })).toThrow(/configured twice/);
  });
});

describe("proposal store from before accounting units", () => {
  it("gains the unit column on init and keeps its rows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "connector-store-"));
    const file = path.join(dir, "old.sqlite");
    try {
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, tool TEXT NOT NULL, kind TEXT NOT NULL,
        agenda TEXT NOT NULL, summary TEXT NOT NULL, args_json TEXT NOT NULL, xml TEXT NOT NULL, xml_hash TEXT NOT NULL, datapack_id TEXT NOT NULL,
        item_id TEXT NOT NULL, state TEXT NOT NULL, proposed_by TEXT NOT NULL, proposed_at TEXT NOT NULL, reason TEXT, approved_by TEXT, approved_at TEXT,
        decision_note TEXT, sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, pohoda_id INTEGER, pohoda_number TEXT, response_state TEXT,
        response_note TEXT, response_xml TEXT, error TEXT)`);
      old.exec(`INSERT INTO proposals (key, tool, kind, agenda, summary, args_json, xml, xml_hash, datapack_id, item_id, state, proposed_by, proposed_at)
        VALUES ('old:1', 'pohoda_create_invoice', 'create', 'invoice', 's', '{}', '<x/>', 'h', 'd', 'old:1', 'proposed', 'a', '2026-09-16T00:00:00Z')`);
      old.close();

      const store = new SqliteOutboxStore(file);
      await store.init();
      try {
        const kept = await store.findByKey("old:1");
        expect(kept?.unit).toBeUndefined();
        const fresh = await store.insert({ key: "new:1", unit: WAITING, tool: "t", kind: "create", agenda: "invoice", summary: "s", args: {}, xml: "<x/>", xmlHash: "h", datapackId: "d", itemId: "new:1", proposedBy: "a" });
        expect(fresh.unit).toBe(WAITING);
        expect((await store.list({ unit: WAITING })).map((p) => p.key)).toEqual(["new:1"]);
      } finally {
        await store.close(); // Windows cannot remove a file SQLite still holds open
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
