import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { loadConfig, parseTokens } from "../src/core/config.js";
import { principalFromBearer } from "../src/core/principal.js";
import { startHttpServer } from "../src/http/server.js";
import { AGENT, HUMAN, harness, okResponse, parseToolJson } from "./helpers.js";

const T1 = "agent-token-agent-token-agent-token-1";
const baseEnv = { POHODA_URL: "http://p:444", POHODA_USERNAME: "u", POHODA_PASSWORD: "p", POHODA_ICO: "12345678" };

function rawStatus(base: string, path: string, extra: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, method: extra.method ?? "GET", headers: extra.headers ?? {} }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(extra.body);
  });
}

describe("configuration gates", () => {
  it("parses tokens by digest; refuses short, malformed and prototype keys", () => {
    const table = parseTokens(JSON.stringify({ [T1]: { name: "a", role: "agent" } }));
    expect(principalFromBearer(table, `Bearer ${T1}`)).toEqual({ name: "a", role: "agent" });
    expect(() => parseTokens(JSON.stringify({ short: { name: "a", role: "agent" } }))).toThrow(/at least 32/);
    expect(() => parseTokens(JSON.stringify({ ["x".repeat(40)]: { name: "a", role: "root" } }))).toThrow(/role/);
    expect(() => parseTokens(JSON.stringify({ constructor: { name: "a", role: "agent" } }))).toThrow(/not an acceptable token/);
    expect(() => parseTokens("[1]")).toThrow(/must be an object/);
  });

  it("direct write mode is refused outside the sandbox", () => {
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_WRITE_MODE: "direct" })).toThrow(/CONNECTOR_SANDBOX=true/);
    expect(loadConfig({ ...baseEnv, CONNECTOR_WRITE_MODE: "direct", CONNECTOR_SANDBOX: "true" }).writeMode).toBe("direct");
  });

  it("http transport needs tokens and, off loopback, an allowed-hosts list", () => {
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_TRANSPORT: "http" })).toThrow(/CONNECTOR_TOKENS/);
    const tokens = JSON.stringify({ [T1]: { name: "a", role: "agent" } });
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_TRANSPORT: "http", CONNECTOR_TOKENS: tokens, CONNECTOR_HTTP_HOST: "0.0.0.0" })).toThrow(/ALLOWED_HOSTS/);
    const cfg = loadConfig({ ...baseEnv, CONNECTOR_TRANSPORT: "http", CONNECTOR_TOKENS: tokens, CONNECTOR_HTTP_HOST: "0.0.0.0", CONNECTOR_HTTP_ALLOWED_HOSTS: "pohoda.lan, pohoda.lan:8444" });
    expect(cfg.http.allowedHosts).toEqual(["pohoda.lan", "pohoda.lan:8444"]);
  });

  it("rejects malformed booleans and integers loudly", () => {
    expect(() => loadConfig({ ...baseEnv, CONNECTOR_ALLOW_DELETE: "yes" })).toThrow(/true\|false/);
    expect(() => loadConfig({ ...baseEnv, POHODA_TIMEOUT: "-1" })).toThrow(/non-negative integer/);
  });
});

describe("write gate input hygiene", () => {
  it("refuses unencodable text before anything is stored", async () => {
    const h = await harness();
    const result = await h.registryFor(AGENT).call("pohoda_create_invoice", { invoiceType: "issuedInvoice", date: "2026-09-16", text: "Faktura 你", idempotencyKey: "enc:1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside Windows-1250/);
    expect(await h.outbox.list({})).toHaveLength(0);
  });
});

describe("concurrent transitions", () => {
  it("two simultaneous approvals: exactly one wins, one send", async () => {
    const h = await harness({ autoSendOnApprove: true });
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", { invoiceType: "issuedInvoice", date: "2026-09-16", text: "race", idempotencyKey: "race:1" }));
    h.client.queue.push(okResponse("race:1", 1), okResponse("race:1", 2));
    const [a, b] = await Promise.all([
      h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId }),
      h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId }),
    ]);
    const errors = [a, b].filter((r) => r.isError);
    expect(errors).toHaveLength(1);
    expect(errors[0].content[0].text).toMatch(/cannot approve|changed concurrently/);
    expect(h.client.sent).toHaveLength(1);
    expect((await h.outbox.events(proposalId as number)).filter((e) => e.toState === "sending")).toHaveLength(1);
  });

  it("a proposal stuck in sending can be replayed, never approved twice", async () => {
    const h = await harness();
    const { proposalId } = parseToolJson(await h.registryFor(AGENT).call("pohoda_create_invoice", { invoiceType: "issuedInvoice", date: "2026-09-16", text: "stuck", idempotencyKey: "stuck:1" }));
    await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId });
    h.client.queue.push(new Error("socket hang up"));
    await h.registryFor(HUMAN).call("pohoda_proposal_send", { id: proposalId });
    await h.store.transition(proposalId as number, ["failed"], { state: "sending" }, { fromState: "failed", toState: "sending", actor: "test" });
    h.client.queue.push(okResponse("stuck:1", 5));
    expect(parseToolJson(await h.registryFor(HUMAN).call("pohoda_proposal_replay", { id: proposalId })).state).toBe("sent");
    expect((await h.registryFor(HUMAN).call("pohoda_proposal_approve", { id: proposalId })).isError).toBe(true);
  });
});

describe("HTTP limits", () => {
  let base = "";
  let close: () => Promise<void> = async () => {};
  const logs: string[] = [];

  beforeAll(async () => {
    const h = await harness({
      transport: "http",
      http: { host: "127.0.0.1", port: 0, tokens: parseTokens(JSON.stringify({ [T1]: { name: "agent", role: "agent" } })), allowedHosts: [], maxSessions: 1, sessionIdleMs: 60_000 },
    });
    const started = await startHttpServer(h.deps, (line) => logs.push(line));
    base = `http://127.0.0.1:${started.port}`;
    close = started.close;
  });

  afterAll(async () => {
    await close();
  });

  it("caps the body from the declared length and rejects bad JSON with 400", async () => {
    expect(await rawStatus(base, "/v1/tools/pohoda_status", { method: "POST", headers: { authorization: `Bearer ${T1}`, "content-length": String(5 * 1024 * 1024) } })).toBe(413);
    const badJson = await fetch(`${base}/v1/tools/pohoda_status`, { method: "POST", headers: { authorization: `Bearer ${T1}`, "content-type": "application/json" }, body: "{not json" });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("caps MCP sessions, pins them to the principal and logs without tokens", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    const headers = { authorization: `Bearer ${T1}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const first = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(init) });
    expect(first.status).toBe(200);
    expect(first.headers.get("mcp-session-id")).toBeTruthy();
    await first.body?.cancel();
    expect((await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(init) })).status).toBe(503);
    expect((await fetch(`${base}/mcp`, { method: "GET", headers })).status).toBe(400);
    expect(logs.some((l) => l.startsWith("http POST /mcp principal=agent"))).toBe(true);
    expect(logs.some((l) => l.includes(T1))).toBe(false);
  });
});
