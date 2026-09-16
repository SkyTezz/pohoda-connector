import type { Principal, Role } from "./principal.js";

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

export interface ConnectorConfig {
  pohoda: {
    url: string;
    username: string;
    password: string;
    ico: string;
    timeout: number;
    maxRetries: number;
  };
  /** `approval` = every write becomes a proposal a human approves; `direct` = legacy pass-through. */
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
  http: { host: string; port: number; tokens: Record<string, Principal> };
  /** Principal used on stdio, where there is no bearer token. */
  stdioPrincipal: Principal;
}

const ROLES: Role[] = ["agent", "human", "service"];

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

function mssqlFromEnv(env: NodeJS.ProcessEnv, prefix: string): MssqlConnection | undefined {
  const server = env[`${prefix}_SERVER`];
  if (!server) return undefined;
  return {
    server,
    port: int(env, `${prefix}_PORT`, 1433),
    database: required(env, `${prefix}_DATABASE`),
    user: required(env, `${prefix}_USER`),
    password: required(env, `${prefix}_PASSWORD`),
    encrypt: bool(env, `${prefix}_ENCRYPT`, false),
    trustServerCertificate: bool(env, `${prefix}_TRUST_CERT`, true),
  };
}

function parseTokens(raw: string | undefined): Record<string, Principal> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`CONNECTOR_TOKENS is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('CONNECTOR_TOKENS must be an object: {"<token>": {"name": "...", "role": "agent|human|service"}}');
  }
  const tokens: Record<string, Principal> = {};
  for (const [token, def] of Object.entries(parsed as Record<string, unknown>)) {
    const d = def as Partial<Principal>;
    if (!d || typeof d.name !== "string" || !ROLES.includes(d.role as Role)) {
      throw new Error(`CONNECTOR_TOKENS entry for a token is invalid; need {name, role}`);
    }
    if (token.length < 24) throw new Error("CONNECTOR_TOKENS: every token must be at least 24 characters");
    tokens[token] = { name: d.name, role: d.role as Role };
  }
  return tokens;
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
  if (transport === "http" && Object.keys(tokens).length === 0) {
    throw new Error("CONNECTOR_TRANSPORT=http requires CONNECTOR_TOKENS (no anonymous HTTP access)");
  }

  return {
    pohoda: {
      url: required(env, "POHODA_URL"),
      username: required(env, "POHODA_USERNAME"),
      password: required(env, "POHODA_PASSWORD"),
      ico: required(env, "POHODA_ICO"),
      timeout: int(env, "POHODA_TIMEOUT", 120_000),
      maxRetries: int(env, "POHODA_MAX_RETRIES", 2),
    },
    writeMode: oneOf(env, "CONNECTOR_WRITE_MODE", ["approval", "direct"] as const, "approval"),
    allowDelete: bool(env, "CONNECTOR_ALLOW_DELETE", false),
    autoSendOnApprove: bool(env, "CONNECTOR_AUTO_SEND_ON_APPROVE", true),
    sandbox: bool(env, "CONNECTOR_SANDBOX", false),
    extSystem: env.CONNECTOR_EXT_SYSTEM || "CONNECTOR",
    store: { kind: storeKind, sqlitePath: env.CONNECTOR_SQLITE_PATH || "./data/connector.sqlite", mssql: storeMssql },
    sql: sql ? { ...sql, maxRows: int(env, "POHODA_SQL_MAX_ROWS", 1000) } : undefined,
    transport,
    http: { host: env.CONNECTOR_HTTP_HOST || "127.0.0.1", port: int(env, "CONNECTOR_HTTP_PORT", 8444), tokens },
    stdioPrincipal: {
      name: env.CONNECTOR_PRINCIPAL_NAME || "stdio",
      role: oneOf(env, "CONNECTOR_PRINCIPAL_ROLE", ROLES, "agent"),
    },
  };
}
