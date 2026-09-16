import { ROLES, TokenTable, type Principal, type Role } from "./principal.js";

/**
 * Runtime configuration, read once from the environment.
 *
 * Every knob that changes what the connector is allowed to do (write mode,
 * delete, sandbox approvals) lives here so that a deployment is auditable from
 * its env file alone. Nothing below is read from process.env anywhere else.
 */
export type WriteMode = "approval" | "direct";
export type StoreKind = "sqlite" | "mssql";
export type Transport = "stdio" | "http";

export interface MssqlConnection {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

export interface HttpConfig {
  host: string;
  port: number;
  tokens: TokenTable;
  /** Host-header allow-list (DNS-rebinding protection). Empty = not enforced. */
  allowedHosts: string[];
  maxSessions: number;
  sessionIdleMs: number;
}

export interface ConnectorConfig {
  pohoda: {
    url: string;
    username: string;
    password: string;
    ico: string;
    timeout: number;
    maxRetries: number;
  };
  /** `approval` = every write becomes a proposal a human approves; `direct` = pass-through, sandbox only. */
  writeMode: WriteMode;
  /** POHODA documents are cancelled with storno/corrective documents, never deleted. Off by default. */
  allowDelete: boolean;
  /** Approving a proposal sends it immediately (one click for the operator). */
  autoSendOnApprove: boolean;
  /** Sandbox accounting unit: agents/services may approve so renderers can be tested end to end. */
  sandbox: boolean;
  /** `exSystemName` written into every document's extId and the dataPack id prefix. */
  extSystem: string;
  store: { kind: StoreKind; sqlitePath: string; mssql?: MssqlConnection };
  /** Read-only SQL access to the accounting unit database (StwPh_<ICO>_<year>). */
  sql?: MssqlConnection & { maxRows: number };
  transport: Transport;
  http: HttpConfig;
  /** Principal used on stdio, where there is no bearer token. */
  stdioPrincipal: Principal;
}

export const DEFAULTS = {
  pohodaTimeoutMs: 120_000,
  pohodaMaxRetries: 2,
  extSystem: "CONNECTOR",
  sqlitePath: "./data/connector.sqlite",
  mssqlPort: 1433,
  sqlMaxRows: 1000,
  httpHost: "127.0.0.1",
  httpPort: 8444,
  httpMaxSessions: 50,
  httpSessionIdleMinutes: 30,
  stdioPrincipalName: "stdio",
  stdioPrincipalRole: "agent" as Role,
} as const;

/** 32 characters of a random token ≈ 190 bits of entropy from a base64/hex generator — enough to rule out guessing. */
export const MIN_TOKEN_LENGTH = 32;
const MS_PER_MINUTE = 60_000;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true|false, got "${raw}"`);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return parsed;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  if (!allowed.includes(raw as T)) throw new Error(`${name} must be one of ${allowed.join("|")}, got "${raw}"`);
  return raw as T;
}

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function mssqlFromEnv(env: NodeJS.ProcessEnv, prefix: string): MssqlConnection | undefined {
  const server = env[`${prefix}_SERVER`];
  if (!server) return undefined;
  return {
    server,
    port: int(env, `${prefix}_PORT`, DEFAULTS.mssqlPort),
    database: required(env, `${prefix}_DATABASE`),
    user: required(env, `${prefix}_USER`),
    password: required(env, `${prefix}_PASSWORD`),
    encrypt: bool(env, `${prefix}_ENCRYPT`, false),
    trustServerCertificate: bool(env, `${prefix}_TRUST_CERT`, true),
  };
}

const FORBIDDEN_TOKEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Parse CONNECTOR_TOKENS into a Map first — never index a JSON object by attacker-controlled keys. */
export function parseTokens(raw: string | undefined): TokenTable {
  if (!raw) return new TokenTable(new Map());
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`CONNECTOR_TOKENS is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('CONNECTOR_TOKENS must be an object: {"<token>": {"name": "...", "role": "agent|human|service"}}');
  }
  const map = new Map<string, Principal>();
  for (const [token, def] of Object.entries(parsed as Record<string, unknown>)) {
    if (FORBIDDEN_TOKEN_KEYS.has(token)) throw new Error(`CONNECTOR_TOKENS: "${token}" is not an acceptable token`);
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`CONNECTOR_TOKENS: every token must be at least ${MIN_TOKEN_LENGTH} characters`);
    const d = def as Partial<Principal> | null;
    if (!d || typeof d !== "object" || typeof d.name !== "string" || d.name.trim() === "" || !ROLES.includes(d.role as Role)) {
      throw new Error("CONNECTOR_TOKENS: every entry needs {name: non-empty string, role: agent|human|service}");
    }
    map.set(token, { name: d.name, role: d.role as Role });
  }
  return new TokenTable(map);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const transport = oneOf(env, "CONNECTOR_TRANSPORT", ["stdio", "http"] as const, "stdio");
  const storeKind = oneOf(env, "CONNECTOR_STORE", ["sqlite", "mssql"] as const, "sqlite");
  const storeMssql = storeKind === "mssql" ? mssqlFromEnv(env, "CONNECTOR_STORE_MSSQL") : undefined;
  if (storeKind === "mssql" && !storeMssql) {
    throw new Error("CONNECTOR_STORE=mssql needs CONNECTOR_STORE_MSSQL_SERVER/_DATABASE/_USER/_PASSWORD");
  }
  const sql = mssqlFromEnv(env, "POHODA_SQL");
  const tokens = parseTokens(env.CONNECTOR_TOKENS);
  if (transport === "http" && tokens.size === 0) {
    throw new Error("CONNECTOR_TRANSPORT=http requires CONNECTOR_TOKENS (no anonymous HTTP access)");
  }
  const writeMode = oneOf(env, "CONNECTOR_WRITE_MODE", ["approval", "direct"] as const, "approval");
  const sandbox = bool(env, "CONNECTOR_SANDBOX", false);
  if (writeMode === "direct" && !sandbox) {
    throw new Error("CONNECTOR_WRITE_MODE=direct bypasses human approval and is allowed only with CONNECTOR_SANDBOX=true");
  }
  const httpHost = env.CONNECTOR_HTTP_HOST || DEFAULTS.httpHost;
  const allowedHosts = list(env, "CONNECTOR_HTTP_ALLOWED_HOSTS");
  if (transport === "http" && !LOOPBACK_HOSTS.includes(httpHost) && allowedHosts.length === 0) {
    throw new Error("CONNECTOR_HTTP_HOST is not loopback: set CONNECTOR_HTTP_ALLOWED_HOSTS (comma-separated Host header values)");
  }

  return {
    pohoda: {
      url: required(env, "POHODA_URL"),
      username: required(env, "POHODA_USERNAME"),
      password: required(env, "POHODA_PASSWORD"),
      ico: required(env, "POHODA_ICO"),
      timeout: int(env, "POHODA_TIMEOUT", DEFAULTS.pohodaTimeoutMs),
      maxRetries: int(env, "POHODA_MAX_RETRIES", DEFAULTS.pohodaMaxRetries),
    },
    writeMode,
    allowDelete: bool(env, "CONNECTOR_ALLOW_DELETE", false),
    autoSendOnApprove: bool(env, "CONNECTOR_AUTO_SEND_ON_APPROVE", true),
    sandbox,
    extSystem: env.CONNECTOR_EXT_SYSTEM || DEFAULTS.extSystem,
    store: { kind: storeKind, sqlitePath: env.CONNECTOR_SQLITE_PATH || DEFAULTS.sqlitePath, mssql: storeMssql },
    sql: sql ? { ...sql, maxRows: int(env, "POHODA_SQL_MAX_ROWS", DEFAULTS.sqlMaxRows) } : undefined,
    transport,
    http: {
      host: httpHost,
      port: int(env, "CONNECTOR_HTTP_PORT", DEFAULTS.httpPort),
      tokens,
      allowedHosts,
      maxSessions: int(env, "CONNECTOR_HTTP_MAX_SESSIONS", DEFAULTS.httpMaxSessions),
      sessionIdleMs: int(env, "CONNECTOR_HTTP_SESSION_IDLE_MINUTES", DEFAULTS.httpSessionIdleMinutes) * MS_PER_MINUTE,
    },
    stdioPrincipal: {
      name: env.CONNECTOR_PRINCIPAL_NAME || DEFAULTS.stdioPrincipalName,
      role: oneOf(env, "CONNECTOR_PRINCIPAL_ROLE", ROLES, DEFAULTS.stdioPrincipalRole),
    },
  };
}
