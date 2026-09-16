import sql from "mssql";
import type { ConnectorConfig } from "../core/config.js";
import type { Dictionary } from "./dictionary.js";

/**
 * Read-only access to the accounting unit database (StwPh_<ICO>_<year>).
 *
 * Only SELECT is ever built here, every identifier is validated against the
 * dictionary, every value is a bound parameter, and TOP caps the row count.
 * The SQL login itself should also be SELECT-only — this class is the second
 * fence, not the first.
 */
export type WhereOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "in" | "isNull" | "notNull";

export interface WhereClause {
  column: string;
  op: WhereOp;
  value?: string | number | boolean | Array<string | number>;
}

export interface SelectQuery {
  table: string;
  columns?: string[];
  where?: WhereClause[];
  orderBy?: Array<{ column: string; direction?: "asc" | "desc" }>;
  limit?: number;
}

const OP_SQL: Record<Exclude<WhereOp, "in" | "isNull" | "notNull">, string> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
};

export interface BuiltQuery {
  text: string;
  params: Array<{ name: string; value: string | number | boolean }>;
}

/** Pure: query description → parameterised T-SQL. Exported for tests. */
export function buildSelect(dictionary: Dictionary, q: SelectQuery, maxRows: number): BuiltQuery {
  const table = dictionary.resolveTable(q.table);
  const columns = (q.columns?.length ? q.columns : ["*"]).map((c) => (c === "*" ? "*" : `[${dictionary.resolveColumn(table, c)}]`));
  const params: BuiltQuery["params"] = [];
  const where = (q.where ?? []).map((w, i) => {
    const column = `[${dictionary.resolveColumn(table, w.column)}]`;
    if (w.op === "isNull") return `${column} IS NULL`;
    if (w.op === "notNull") return `${column} IS NOT NULL`;
    if (w.op === "in") {
      if (!Array.isArray(w.value) || w.value.length === 0) throw new Error(`where[${i}]: "in" needs a non-empty array value`);
      const names = w.value.map((v, j) => {
        const name = `w${i}_${j}`;
        params.push({ name, value: v });
        return `@${name}`;
      });
      return `${column} IN (${names.join(", ")})`;
    }
    if (w.value === undefined || Array.isArray(w.value)) throw new Error(`where[${i}]: "${w.op}" needs a scalar value`);
    const name = `w${i}`;
    params.push({ name, value: w.value });
    return `${column} ${OP_SQL[w.op]} @${name}`;
  });
  const orderBy = (q.orderBy ?? []).map((o) => `[${dictionary.resolveColumn(table, o.column)}] ${o.direction === "desc" ? "DESC" : "ASC"}`);
  const limit = q.limit == null ? maxRows : Math.min(Math.max(1, Math.trunc(q.limit)), maxRows);
  const text =
    `SELECT TOP (${limit}) ${columns.join(", ")} FROM [dbo].[${table}]` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    (orderBy.length ? ` ORDER BY ${orderBy.join(", ")}` : " ORDER BY [ID]");
  return { text, params };
}

export class SqlReader {
  private pool: sql.ConnectionPool | undefined;

  constructor(
    private readonly conn: NonNullable<ConnectorConfig["sql"]>,
    readonly dictionary: Dictionary,
  ) {}

  get database(): string {
    return this.conn.database;
  }

  async connect(): Promise<void> {
    this.pool = await new sql.ConnectionPool({
      server: this.conn.server,
      port: this.conn.port,
      database: this.conn.database,
      user: this.conn.user,
      password: this.conn.password,
      options: { encrypt: this.conn.encrypt, trustServerCertificate: this.conn.trustServerCertificate, readOnlyIntent: true },
      pool: { max: 4 },
    }).connect();
  }

  async ping(): Promise<{ database: string; server: string }> {
    const res = await this.request().query<{ db: string; server: string }>("SELECT DB_NAME() AS db, @@SERVERNAME AS server");
    return { database: res.recordset[0].db, server: res.recordset[0].server };
  }

  private request(): sql.Request {
    if (!this.pool) throw new Error("SqlReader.connect() was not called");
    return this.pool.request();
  }

  async select<T = Record<string, unknown>>(q: SelectQuery): Promise<{ rows: T[]; sql: string }> {
    const built = buildSelect(this.dictionary, q, this.conn.maxRows);
    const req = this.request();
    for (const p of built.params) req.input(p.name, p.value as never);
    const res = await req.query<T>(built.text);
    return { rows: res.recordset, sql: built.text };
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = undefined;
  }
}
