import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttpServer } from "../src/http/server.js";
import { harness, okResponse } from "./helpers.js";

const AGENT_TOKEN = "agent-token-agent-token-agent-token";
const HUMAN_TOKEN = "human-token-human-token-human-token";

describe("HTTP REST facade", () => {
  let base = "";
  let close: () => Promise<void> = async () => {};
  let h: Awaited<ReturnType<typeof harness>>;

  beforeAll(async () => {
    h = await harness({
      transport: "http",
      http: { host: "127.0.0.1", port: 0, tokens: { [AGENT_TOKEN]: { name: "agent", role: "agent" }, [HUMAN_TOKEN]: { name: "operator", role: "human" } } },
    });
    const started = await startHttpServer(h.deps);
    base = `http://127.0.0.1:${started.port}`;
    close = started.close;
  });

  afterAll(async () => {
    await close();
  });

  const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("healthz is open, everything else needs a token", async () => {
    expect((await call(undefined, "GET", "/v1/healthz")).status).toBe(200);
    const denied = await call(undefined, "GET", "/v1/tools");
    expect(denied.status).toBe(403);
    expect((await call("short", "GET", "/v1/tools")).status).toBe(403);
  });

  it("lists tools and runs the full propose → approve → send flow over REST", async () => {
    const tools = (await (await call(AGENT_TOKEN, "GET", "/v1/tools")).json()) as { tools: Array<{ name: string }> };
    expect(tools.tools.map((t) => t.name)).toContain("pohoda_create_invoice");
    expect(tools.tools.map((t) => t.name)).toContain("pohoda_proposal_approve");

    const proposed = await call(AGENT_TOKEN, "POST", "/v1/tools/pohoda_create_invoice", {
      args: { invoiceType: "issuedInvoice", date: "2026-09-16", text: "REST test", idempotencyKey: "rest:1" },
    });
    expect(proposed.status).toBe(200);
    const proposedBody = (await proposed.json()) as { data: { proposalId: number; state: string } };
    expect(proposedBody.data.state).toBe("proposed");
    const id = proposedBody.data.proposalId;

    const listed = (await (await call(AGENT_TOKEN, "GET", "/v1/proposals?state=proposed")).json()) as { data: Array<{ id: number }> };
    expect(listed.data.map((p) => p.id)).toContain(id);

    const deniedApprove = await call(AGENT_TOKEN, "POST", `/v1/proposals/${id}/approve`, {});
    expect(deniedApprove.status).toBe(422);

    const approved = await call(HUMAN_TOKEN, "POST", `/v1/proposals/${id}/approve`, { note: "ok" });
    expect(approved.status).toBe(200);

    h.client.queue.push(okResponse("rest:1", 77, "26FV00077"));
    const sent = (await (await call(HUMAN_TOKEN, "POST", `/v1/proposals/${id}/send`, {})).json()) as { data: { state: string; pohodaId: number } };
    expect(sent.data.state).toBe("sent");
    expect(sent.data.pohodaId).toBe(77);

    const detail = (await (await call(AGENT_TOKEN, "GET", `/v1/proposals/${id}`)).json()) as { data: { pohodaNumber: string; events: unknown[] } };
    expect(detail.data.pohodaNumber).toBe("26FV00077");
    expect(detail.data.events).toHaveLength(4);
  });

  it("validates arguments and unknown tools", async () => {
    expect((await call(AGENT_TOKEN, "POST", "/v1/tools/pohoda_create_invoice", { args: { invoiceType: "nope" } })).status).toBe(400);
    expect((await call(AGENT_TOKEN, "POST", "/v1/tools/pohoda_nothing", { args: {} })).status).toBe(400);
  });
});
