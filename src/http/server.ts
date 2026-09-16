import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ForbiddenError, principalFromBearer, type Principal } from "../core/principal.js";
import type { ToolRegistry } from "../core/registry.js";
import type { ToolResult } from "../core/types.js";
import { EncodingError } from "../xml/encoding.js";
import { ProposalStateError } from "../outbox/service.js";
import { createRegistry, type ServerDeps } from "../server.js";

/**
 * Two doors on one port:
 *   /mcp     — MCP Streamable HTTP (agents), one session per initialize
 *   /v1/...  — plain REST for backends (the calling application's operator UI)
 * Both require a bearer token from CONNECTOR_TOKENS; the token decides the role.
 *
 * Safety properties enforced here: bearer auth on everything but /v1/healthz,
 * optional Host allow-list (DNS rebinding), bounded request body, bounded
 * number of MCP sessions with idle eviction, principal pinned to its session,
 * internal errors redacted from clients and logged server-side with a request id.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_SWEEP_INTERVAL_MS = 60_000;
const HTTP = {
  OK: 200,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

const PROPOSAL_ACTION_TOOLS: Record<string, string> = {
  approve: "pohoda_proposal_approve",
  reject: "pohoda_proposal_reject",
  send: "pohoda_proposal_send",
  replay: "pohoda_proposal_replay",
};

interface Session {
  transport: StreamableHTTPServerTransport;
  principal: Principal;
  lastSeenAt: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RunningHttpServer {
  port: number;
  close: () => Promise<void>;
}

export function startHttpServer(deps: ServerDeps, log: (line: string) => void = (line) => console.error(line)): Promise<RunningHttpServer> {
  const { host, port, tokens, allowedHosts, maxSessions, sessionIdleMs } = deps.config.http;
  const sessions = new Map<string, Session>();
  const restRegistries = new Map<string, ToolRegistry>();

  const restRegistry = (principal: Principal): ToolRegistry => {
    const key = `${principal.role}:${principal.name}`;
    const cached = restRegistries.get(key);
    if (cached) return cached;
    const registry = createRegistry(deps, principal, false).registry;
    restRegistries.set(key, registry);
    return registry;
  };

  const evictIdleSessions = (): void => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < cutoff) {
        sessions.delete(id);
        void session.transport.close();
      }
    }
  };
  const sweeper = setInterval(evictIdleSessions, SESSION_SWEEP_INTERVAL_MS);
  sweeper.unref();

  const boundPort = (): number => {
    const address = server.address();
    return typeof address === "object" && address ? address.port : port;
  };

  const server = createHttpServer(async (req, res) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.setHeader("X-Request-ID", requestId);
    let principalName = "-";
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      assertAllowedHost(req, allowedHosts);
      if (url.pathname === "/v1/healthz" && req.method === "GET") return json(res, HTTP.OK, { ok: true, version: "v1" });

      const principal = principalFromBearer(tokens, req.headers.authorization);
      principalName = principal.name;

      // `return await` so a rejection inside the handlers lands in this catch and
      // becomes a JSON error instead of an unhandled rejection with a hanging socket.
      if (url.pathname === "/mcp") return await handleMcp(req, res, principal);
      if (url.pathname.startsWith("/v1/")) return await handleRest(req, res, url, principal, requestId);
      throw new HttpError(HTTP.NOT_FOUND, "not_found", `no route ${req.method} ${url.pathname}`);
    } catch (e) {
      sendError(res, e, requestId, log);
    } finally {
      log(`http ${req.method} ${req.url} principal=${principalName} status=${res.statusCode} ms=${Date.now() - startedAt} rid=${requestId}`);
    }
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      if (existing.principal.name !== principal.name || existing.principal.role !== principal.role) {
        throw new ForbiddenError("session belongs to a different principal");
      }
      existing.lastSeenAt = Date.now();
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST") throw new HttpError(HTTP.BAD_REQUEST, "no_session", "mcp-session-id header required");
    const body = await readJson(req);
    if (!isInitializeRequest(body)) throw new HttpError(HTTP.BAD_REQUEST, "no_session", "first request must be initialize");
    evictIdleSessions();
    if (sessions.size >= maxSessions) throw new HttpError(HTTP.SERVICE_UNAVAILABLE, "too_many_sessions", `session limit ${maxSessions} reached`);

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: allowedHosts.length > 0,
      allowedHosts: allowedHosts.length > 0 ? withPortVariants(allowedHosts, boundPort()) : undefined,
      onsessioninitialized: (id: string): void => {
        sessions.set(id, { transport, principal, lastSeenAt: Date.now() });
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
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", resource, ...]
    const [, resource, id, action] = parts;

    if (resource === "tools" && parts.length === 2 && req.method === "GET") {
      return json(res, HTTP.OK, { tools: registry.list(), principal, request_id: requestId });
    }
    if (resource === "tools" && parts.length === 3 && req.method === "POST") {
      const body = (await readJson(req)) as { args?: unknown } | undefined;
      return toolResponse(res, requestId, await registry.call(id, body?.args ?? {}));
    }
    if (resource === "proposals" && parts.length === 2 && req.method === "GET") {
      const args: Record<string, unknown> = Object.fromEntries(["state", "tool"].filter((k) => url.searchParams.get(k)).map((k) => [k, url.searchParams.get(k)]));
      if (url.searchParams.get("limit")) args.limit = Number(url.searchParams.get("limit"));
      return toolResponse(res, requestId, await registry.call("pohoda_proposals_list", args));
    }
    if (resource === "proposals" && parts.length === 3 && req.method === "GET") {
      return toolResponse(res, requestId, await registry.call("pohoda_proposal_get", { id: Number(id) }));
    }
    if (resource === "proposals" && parts.length === 4 && req.method === "POST") {
      const tool = PROPOSAL_ACTION_TOOLS[action];
      if (!tool) throw new HttpError(HTTP.NOT_FOUND, "not_found", `unknown proposal action ${action}`);
      const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
      return toolResponse(res, requestId, await registry.call(tool, { id: Number(id), ...body }));
    }
    throw new HttpError(HTTP.NOT_FOUND, "not_found", `no route ${req.method} ${url.pathname}`);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        port: boundPort(),
        close: () =>
          new Promise<void>((done, fail) => {
            clearInterval(sweeper);
            for (const s of sessions.values()) void s.transport.close();
            sessions.clear();
            server.close((e) => (e ? fail(e) : done()));
          }),
      });
    });
  });
}

/** The SDK compares the full Host header; accept "name" as "name" and "name:<port>". */
function withPortVariants(hosts: string[], port: number): string[] {
  return [...new Set(hosts.flatMap((h) => (h.includes(":") ? [h] : [h, `${h}:${port}`])))];
}

function assertAllowedHost(req: IncomingMessage, allowedHosts: string[] | undefined): void {
  if (!allowedHosts || allowedHosts.length === 0) return;
  const hostHeader = (req.headers.host ?? "").toLowerCase();
  const hostname = hostHeader.replace(/:\d+$/, "");
  const ok = allowedHosts.some((h) => h.toLowerCase() === hostHeader || h.toLowerCase() === hostname);
  if (!ok) throw new HttpError(HTTP.FORBIDDEN, "host_not_allowed", "Host header not in CONNECTOR_HTTP_ALLOWED_HOSTS");
}

/** Tool results carry human-readable text with an embedded JSON payload; expose both. */
function toolResponse(res: ServerResponse, requestId: string, result: ToolResult): void {
  const text = result.content.map((c) => c.text).join("\n");
  json(res, result.isError ? HTTP.UNPROCESSABLE : HTTP.OK, { ok: !result.isError, text, data: embeddedJson(text), request_id: requestId });
}

function embeddedJson(text: string): unknown {
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) return undefined;
  const start = Math.min(...starts);
  const closer = text[start] === "{" ? "}" : "]";
  try {
    return JSON.parse(text.slice(start, text.lastIndexOf(closer) + 1));
  } catch {
    return undefined;
  }
}

function sendError(res: ServerResponse, e: unknown, requestId: string, log: (line: string) => void): void {
  if (e instanceof HttpError) return json(res, e.status, { error: { code: e.code, message: e.message }, request_id: requestId });
  if (e instanceof ForbiddenError) return json(res, HTTP.FORBIDDEN, { error: { code: e.code, message: e.message }, request_id: requestId });
  if (e instanceof ProposalStateError) return json(res, HTTP.CONFLICT, { error: { code: e.code, message: e.message }, request_id: requestId });
  if (e instanceof EncodingError) return json(res, HTTP.UNPROCESSABLE, { error: { code: e.code, message: e.message }, request_id: requestId });
  const message = (e as Error).message ?? String(e);
  if (/^invalid arguments|^unknown tool|^Unexpected token|JSON/.test(message)) {
    return json(res, HTTP.BAD_REQUEST, { error: { code: "bad_request", message }, request_id: requestId });
  }
  // Internal details (SQL text, stack traces, upstream messages) stay in the server log.
  log(`error rid=${requestId} ${(e as Error).stack ?? message}`);
  json(res, HTTP.INTERNAL, { error: { code: "internal", message: `internal error, see server log for request ${requestId}` }, request_id: requestId });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store" });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(HTTP.PAYLOAD_TOO_LARGE, "payload_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(HTTP.PAYLOAD_TOO_LARGE, "payload_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(HTTP.BAD_REQUEST, "bad_request", `body is not valid JSON: ${(e as Error).message}`);
  }
}
