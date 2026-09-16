import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ForbiddenError, principalFromBearer, type Principal } from "../core/principal.js";
import type { ToolRegistry } from "../core/registry.js";
import { ProposalStateError } from "../outbox/service.js";
import { createRegistry, type ServerDeps } from "../server.js";

/**
 * Two doors on one port:
 *   /mcp     — MCP Streamable HTTP (agents), one session per initialize
 *   /v1/...  — plain REST for backends (the calling application's operator UI)
 * Both require a bearer token from CONNECTOR_TOKENS; the token decides the role.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface Session {
  transport: StreamableHTTPServerTransport;
  principal: Principal;
}

export function startHttpServer(deps: ServerDeps): Promise<{ close: () => Promise<void>; port: number }> {
  const { host, port, tokens } = deps.config.http;
  const sessions = new Map<string, Session>();
  const restRegistries = new Map<string, ToolRegistry>();

  const restRegistry = (principal: Principal): ToolRegistry => {
    const key = `${principal.role}:${principal.name}`;
    let registry = restRegistries.get(key);
    if (!registry) {
      registry = createRegistry(deps, principal, false).registry;
      restRegistries.set(key, registry);
    }
    return registry;
  };

  const server = createHttpServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/v1/healthz" && req.method === "GET") return json(res, 200, { ok: true, version: "v1" });

      const principal = principalFromBearer(tokens, req.headers.authorization);

      // `return await` so a rejection inside the handlers lands in this catch and
      // becomes a JSON error instead of an unhandled rejection with a hanging socket.
      if (url.pathname === "/mcp") return await handleMcp(req, res, url, principal);
      if (url.pathname.startsWith("/v1/")) return await handleRest(req, res, url, principal, requestId);
      return json(res, 404, { error: { code: "not_found", message: `no route ${req.method} ${url.pathname}` }, request_id: requestId });
    } catch (e) {
      return sendError(res, e, requestId);
    }
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse, _url: URL, principal: Principal): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      if (existing.principal.name !== principal.name || existing.principal.role !== principal.role) {
        throw new ForbiddenError("session belongs to a different principal");
      }
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST") {
      json(res, 400, { error: { code: "no_session", message: "mcp-session-id header required" } });
      return;
    }
    const body = await readJson(req);
    if (!isInitializeRequest(body)) {
      json(res, 400, { error: { code: "no_session", message: "first request must be initialize" } });
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        sessions.set(id, { transport, principal });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const { mcp } = createRegistry(deps, principal, true);
    await mcp!.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal, requestId: string): Promise<void> {
    const registry = restRegistry(principal);
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]

    if (parts[1] === "tools" && parts.length === 2 && req.method === "GET") {
      return json(res, 200, { tools: registry.list(), principal, request_id: requestId });
    }
    if (parts[1] === "tools" && parts.length === 3 && req.method === "POST") {
      const body = (await readJson(req)) as { args?: unknown } | undefined;
      return toolResponse(res, requestId, await registry.call(parts[2], body?.args ?? {}));
    }
    if (parts[1] === "proposals" && parts.length === 2 && req.method === "GET") {
      const args: Record<string, unknown> = {};
      for (const key of ["state", "tool"]) if (url.searchParams.get(key)) args[key] = url.searchParams.get(key);
      if (url.searchParams.get("limit")) args.limit = Number(url.searchParams.get("limit"));
      return toolResponse(res, requestId, await registry.call("pohoda_proposals_list", args));
    }
    if (parts[1] === "proposals" && parts.length === 3 && req.method === "GET") {
      return toolResponse(res, requestId, await registry.call("pohoda_proposal_get", { id: Number(parts[2]) }));
    }
    if (parts[1] === "proposals" && parts.length === 4 && req.method === "POST") {
      const action = parts[3];
      const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
      const toolByAction: Record<string, string> = {
        approve: "pohoda_proposal_approve",
        reject: "pohoda_proposal_reject",
        send: "pohoda_proposal_send",
        replay: "pohoda_proposal_replay",
      };
      const tool = toolByAction[action];
      if (!tool) return json(res, 404, { error: { code: "not_found", message: `unknown proposal action ${action}` }, request_id: requestId });
      return toolResponse(res, requestId, await registry.call(tool, { id: Number(parts[2]), ...body }));
    }
    return json(res, 404, { error: { code: "not_found", message: `no route ${req.method} ${url.pathname}` }, request_id: requestId });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((done, fail) => {
            for (const s of sessions.values()) void s.transport.close();
            server.close((e) => (e ? fail(e) : done()));
          }),
      });
    });
  });
}

function toolResponse(res: ServerResponse, requestId: string, result: { content: Array<{ type: string; text: string }>; isError?: boolean }): void {
  const text = result.content.map((c) => c.text).join("\n");
  let parsed: unknown = undefined;
  const jsonStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const start = [jsonStart, arrayStart].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start != null) {
    try {
      parsed = JSON.parse(text.slice(start, text.lastIndexOf(text[start] === "{" ? "}" : "]") + 1));
    } catch {
      parsed = undefined;
    }
  }
  json(res, result.isError ? 422 : 200, { ok: !result.isError, text, data: parsed, request_id: requestId });
}

function sendError(res: ServerResponse, e: unknown, requestId: string): void {
  if (e instanceof ForbiddenError) return json(res, 403, { error: { code: e.code, message: e.message }, request_id: requestId });
  if (e instanceof ProposalStateError) return json(res, 409, { error: { code: e.code, message: e.message }, request_id: requestId });
  const message = (e as Error).message ?? String(e);
  const status = /^invalid arguments|^unknown tool/.test(message) ? 400 : 500;
  json(res, status, { error: { code: status === 400 ? "bad_request" : "internal", message }, request_id: requestId });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}
