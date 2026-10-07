import sql from "mssql";
import type { ConnectorConfig } from "../core/config.js";
import type { Dictionary } from "./dictionary.js";

/**
 * Read-only access to the accounting unit databases (StwPh_<ICO>_<year>).
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
  /** Accounting-unit database to read; default = the configured one. */
  database?: string;
  table: string;
  columns?: string[];
  where?: WhereClause[];
  orderBy?: Array<{ column: string; direction?: "asc" | "desc" }>;
  limit?: number;
}

export type AggregateFn = "count" | "countDistinct" | "sum" | "min" | "max";

export interface AggregateSpec {
  fn: AggregateFn;
  /** Required for everything except a bare `count` (= COUNT(*)). */
  column?: string;
  /** Name of the result column. */
  as: string;
}

export interface AggregateQuery {
  database?: string;
  table: string;
  groupBy?: string[];
  aggregates: AggregateSpec[];
  where?: WhereClause[];
  /** `by` is a groupBy column or an aggregate alias. */
  orderBy?: Array<{ by: string; direction?: "asc" | "desc" }>;
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

/** `<prefix>_<IČO>_<year>`: one accounting unit, one year. The prefix is chosen when POHODA is installed ("StwPh" by default). */
const UNIT_DATABASE = /^([A-Za-z][A-Za-z0-9]{0,30})_(\d{6,10})_(\d{4})$/;
/** `POHODA_SQL_ALLOWED_ICOS=*`: every accounting unit of the installation may be read. */
export const ALL_UNITS = "*";
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,29}$/;
const MAX_AGGREGATES = 12;
const MAX_GROUP_BY = 8;
/** SQL Server `money` has four decimals; style 2 of CONVERT prints all of them, so a sum leaves the server as exact text, not a float. */
const MONEY_AS_TEXT_STYLE = 2;
const MONEY_TEXT_LENGTH = 40;
const DATABASE_ONLINE = 0;

export interface UnitDatabase {
  name: string;
  prefix: string;
  ico: string;
  year: number;
}

/** Pure: the accounting unit and year a database name stands for, or undefined when it is not a unit database. */
export function parseUnitDatabase(name: string): UnitDatabase | undefined {
  const m = UNIT_DATABASE.exec(name);
  return m ? { name, prefix: m[1], ico: m[2], year: Number(m[3]) } : undefined;
}

/**
 * Pure: may the reader touch `name`? The configured database always. Another
 * database only when it is a unit database of the same installation (same
 * prefix) and its IČO is allowed: by default the configured unit's own IČO
 * (its other years), a listed IČO, or every unit with `*`.
 */
export function isAllowedDatabase(name: string, configured: string, allowedIcos: readonly string[]): boolean {
  if (name === configured) return true;
  const unit = parseUnitDatabase(name);
  const home = parseUnitDatabase(configured);
  if (!unit || !home || unit.prefix !== home.prefix) return false;
  if (allowedIcos.includes(ALL_UNITS)) return true;
  return allowedIcos.length === 0 ? unit.ico === home.ico : allowedIcos.includes(unit.ico);
}

export interface BuiltQuery {
  text: string;
  params: Array<{ name: string; value: string | number | boolean }>;
}

/** `database` reaches here only after isAllowedDatabase, so its characters are the ones UNIT_DATABASE admits. */
function fromClause(table: string, database: string | undefined): string {
  return database ? `[${database}].[dbo].[${table}]` : `[dbo].[${table}]`;
}

function buildWhere(dictionary: Dictionary, table: string, where: WhereClause[] | undefined, params: BuiltQuery["params"]): string[] {
  return (where ?? []).map((w, i) => {
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
    const op = OP_SQL[w.op as keyof typeof OP_SQL];
    if (!op) throw new Error(`where[${i}]: unsupported operator "${w.op}"`);
    const name = `w${i}`;
    params.push({ name, value: w.value });
    return `${column} ${op} @${name}`;
  });
}

function capRows(limit: number | undefined, maxRows: number): number {
  return limit == null ? maxRows : Math.min(Math.max(1, Math.trunc(limit)), maxRows);
}

/** Pure: query description → parameterised T-SQL. Exported for tests. */
export function buildSelect(dictionary: Dictionary, q: SelectQuery, maxRows: number, database?: string): BuiltQuery {
  const table = dictionary.resolveTable(q.table);
  const columns = (q.columns?.length ? q.columns : ["*"]).map((c) => (c === "*" ? "*" : `[${dictionary.resolveColumn(table, c)}]`));
  const params: BuiltQuery["params"] = [];
  const where = buildWhere(dictionary, table, q.where, params);
  const orderBy = (q.orderBy ?? []).map((o) => `[${dictionary.resolveColumn(table, o.column)}] ${o.direction === "desc" ? "DESC" : "ASC"}`);
  const text =
    `SELECT TOP (${capRows(q.limit, maxRows)}) ${columns.join(", ")} FROM ${fromClause(table, database)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    (orderBy.length ? ` ORDER BY ${orderBy.join(", ")}` : " ORDER BY [ID]");
  return { text, params };
}

function aggregateExpression(dictionary: Dictionary, table: string, spec: AggregateSpec, index: number): string {
  if (spec.fn === "count" && spec.column == null) return "COUNT(*)";
  if (spec.column == null) throw new Error(`aggregates[${index}]: "${spec.fn}" needs a column`);
  const canonical = dictionary.resolveColumn(table, spec.column);
  const column = `[${canonical}]`;
  if (spec.fn === "count") return `COUNT(${column})`;
  if (spec.fn === "countDistinct") return `COUNT(DISTINCT ${column})`;
  const fn = { sum: "SUM", min: "MIN", max: "MAX" }[spec.fn];
  if (!fn) throw new Error(`aggregates[${index}]: unsupported function "${spec.fn}"`);
  const isMoney = dictionary.columns(table)[canonical].type === "money";
  return isMoney ? `CONVERT(varchar(${MONEY_TEXT_LENGTH}), ${fn}(${column}), ${MONEY_AS_TEXT_STYLE})` : `${fn}(${column})`;
}

/**
 * Pure: grouped totals over one table (COUNT/SUM/MIN/MAX … GROUP BY). Sums of
 * `money` columns come back as exact decimal text. Exported for tests.
 */
export function buildAggregate(dictionary: Dictionary, q: AggregateQuery, maxRows: number, database?: string): BuiltQuery {
  const table = dictionary.resolveTable(q.table);
  const group = (q.groupBy ?? []).map((c) => dictionary.resolveColumn(table, c));
  if (group.length > MAX_GROUP_BY) throw new Error(`groupBy: at most ${MAX_GROUP_BY} columns`);
  if (q.aggregates.length === 0 || q.aggregates.length > MAX_AGGREGATES) throw new Error(`aggregates: give 1 to ${MAX_AGGREGATES}`);
  const taken = new Set(group.map((c) => c.toLowerCase()));
  const aggregates = q.aggregates.map((spec, i) => {
    if (!ALIAS.test(spec.as)) throw new Error(`aggregates[${i}]: alias "${spec.as}" must be a plain identifier of at most 30 characters`);
    if (taken.has(spec.as.toLowerCase())) throw new Error(`aggregates[${i}]: alias "${spec.as}" is already used`);
    taken.add(spec.as.toLowerCase());
    return `${aggregateExpression(dictionary, table, spec, i)} AS [${spec.as}]`;
  });
  const params: BuiltQuery["params"] = [];
  const where = buildWhere(dictionary, table, q.where, params);
  const sortable = new Map<string, string>([...group, ...q.aggregates.map((a) => a.as)].map((name) => [name.toLowerCase(), name]));
  const orderBy = (q.orderBy ?? group.map((by) => ({ by, direction: "asc" as const }))).map((o, i) => {
    const name = sortable.get(o.by.toLowerCase());
    if (!name) throw new Error(`orderBy[${i}]: "${o.by}" is neither a groupBy column nor an aggregate alias`);
    return `[${name}] ${o.direction === "desc" ? "DESC" : "ASC"}`;
  });
  const text =
    `SELECT TOP (${capRows(q.limit, maxRows)}) ${[...group.map((c) => `[${c}]`), ...aggregates].join(", ")} FROM ${fromClause(table, database)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    (group.length ? ` GROUP BY ${group.map((c) => `[${c}]`).join(", ")}` : "") +
    (orderBy.length ? ` ORDER BY ${orderBy.join(", ")}` : "");
  return { text, params };
}

export class SqlReader {
  private pool: sql.ConnectionPool | undefined;

  constructor(
    private readonly conn: NonNullable<ConnectorConfig["sql"]>,
    readonly dictionary: Dictionary,
  ) {}

  /** The configured (default) database. */
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

  /** The database a query runs against; a name outside the allowed set is refused before any SQL is built. */
  resolveDatabase(name: string | undefined): string {
    if (name == null || name === "") return this.conn.database;
    if (!isAllowedDatabase(name, this.conn.database, this.conn.allowedIcos)) {
      throw new Error(`database "${name}" is not an accounting-unit database this connector may read (see pohoda_sql_databases)`);
    }
    return name;
  }

  /** Accounting-unit databases on the server that this connector may read: one per unit and year. */
  async databases(): Promise<UnitDatabase[]> {
    const res = await this.request()
      .input("online", DATABASE_ONLINE)
      .query<{ name: string }>("SELECT [name] FROM [sys].[databases] WHERE [state] = @online ORDER BY [name]");
    return res.recordset
      .filter((row) => isAllowedDatabase(row.name, this.conn.database, this.conn.allowedIcos))
      .map((row) => parseUnitDatabase(row.name))
      .filter((unit): unit is UnitDatabase => unit !== undefined);
  }

  private async run<T>(built: BuiltQuery): Promise<{ rows: T[]; sql: string }> {
    const req = this.request();
    for (const p of built.params) req.input(p.name, p.value as never);
    const res = await req.query<T>(built.text);
    return { rows: res.recordset, sql: built.text };
  }

  async select<T = Record<string, unknown>>(q: SelectQuery): Promise<{ rows: T[]; sql: string }> {
    return this.run<T>(buildSelect(this.dictionary, q, this.conn.maxRows, this.resolveDatabase(q.database)));
  }

  async aggregate<T = Record<string, unknown>>(q: AggregateQuery): Promise<{ rows: T[]; sql: string }> {
    return this.run<T>(buildAggregate(this.dictionary, q, this.conn.maxRows, this.resolveDatabase(q.database)));
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = undefined;
  }
}
