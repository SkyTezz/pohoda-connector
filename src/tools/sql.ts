import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { ok, err, jsonResult } from "../core/types.js";
import { toIsoDate } from "../core/shared.js";
import type { SqlReader } from "../sql/reader.js";

const whereSchema = z.object({
  column: z.string(),
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "like", "in", "isNull", "notNull"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
});

/**
 * Read-only SQL tools over the POHODA database. Available only when
 * POHODA_SQL_* is configured; every query is validated against the vendored
 * dictionary (schema/pohoda-tables.json) and parameterised.
 */
export function registerSqlTools(host: ToolHost, ctx: ConnectorContext): void {
  const reader = ctx.sql;
  if (!reader) return;

  host.tool(
    "pohoda_sql_tables",
    "List POHODA database tables known to the dictionary (name, maintained class, column count). Read-only SQL.",
    { filter: z.string().optional().describe("Substring filter on table name (case-insensitive)") },
    async ({ filter }) => {
      const needle = filter?.toLowerCase();
      const rows = reader.dictionary
        .tableNames()
        .filter((t) => !needle || t.toLowerCase().includes(needle))
        .map((t) => ({ table: t, class: reader.dictionary.tables[t].class, columns: Object.keys(reader.dictionary.columns(t)).length }));
      return jsonResult("Tables", rows, rows.length);
    },
  );

  host.tool(
    "pohoda_sql_describe",
    "Describe a POHODA table: columns with SQL type, size and default. Use before pohoda_sql_select.",
    { table: z.string().describe("Table name, e.g. FA, FApol, pUD, Uhrady, sExtID") },
    async ({ table }) => {
      try {
        const canonical = reader.dictionary.resolveTable(table);
        const columns = Object.entries(reader.dictionary.columns(canonical)).map(([name, def]) => ({ name, ...def }));
        return jsonResult(`Table ${canonical}`, columns, columns.length);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_sql_select",
    "Run a parameterised SELECT against the POHODA database (read-only). Table and columns must exist in the dictionary; rows are capped by POHODA_SQL_MAX_ROWS.",
    {
      table: z.string().describe("Table name, e.g. FA"),
      columns: z.array(z.string()).optional().describe("Columns to return (default all)"),
      where: z.array(whereSchema).optional().describe("AND-ed conditions: {column, op, value}"),
      orderBy: z.array(z.object({ column: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(),
      limit: z.number().int().min(1).optional().describe("Row cap (default and max = POHODA_SQL_MAX_ROWS)"),
    },
    async (q) => runSelect(reader, "Rows", q),
  );

  host.tool(
    "pohoda_sql_journal",
    "Accounting journal (pUD) rows for a date range: date, document number, text, MD/D accounts, amount, source agenda. Read-only SQL.",
    {
      dateFrom: z.string().describe("From date (DD.MM.YYYY or YYYY-MM-DD)"),
      dateTill: z.string().describe("Till date"),
      account: z.string().optional().describe("Only rows where UMD or UD starts with this account, e.g. 311"),
      limit: z.number().int().min(1).optional(),
    },
    async ({ dateFrom, dateTill, account, limit }) => {
      const where = [
        { column: "Datum", op: "gte" as const, value: toIsoDate(dateFrom) },
        { column: "Datum", op: "lte" as const, value: `${toIsoDate(dateTill)}T23:59:59` },
      ];
      const result = await runSelect(reader, "Journal", {
        table: "pUD",
        columns: ["ID", "Datum", "DatZdPln", "Cislo", "SText", "UMD", "UD", "Kc", "RelUdAg", "RelAgID", "RefAD", "Firma", "ParSym", "DatSave"],
        where,
        orderBy: [{ column: "Datum" }, { column: "ID" }],
        limit,
      });
      if (!account || result.isError) return result;
      // Account prefix filter is applied after fetch: UMD/UD are short strings and a LIKE on both sides would need OR, which buildSelect deliberately does not offer.
      const text = result.content[0]?.text ?? "";
      const body = text.slice(text.indexOf("\n\n") + 2);
      const rows = (JSON.parse(body) as Array<{ UMD?: string; UD?: string }>).filter((r) => String(r.UMD ?? "").startsWith(account) || String(r.UD ?? "").startsWith(account));
      return jsonResult("Journal", rows, rows.length);
    },
  );

  host.tool(
    "pohoda_sql_payments",
    "Payment/liquidation links (Uhrady) for a date range: which payment document settled which invoice and how much. Read-only SQL.",
    {
      dateFrom: z.string().describe("From date"),
      dateTill: z.string().describe("Till date"),
      variableSymbol: z.string().optional().describe("Only links whose paid document carries this variable symbol"),
      limit: z.number().int().min(1).optional(),
    },
    async ({ dateFrom, dateTill, variableSymbol, limit }) => {
      const where = [
        { column: "DatumU", op: "gte" as const, value: toIsoDate(dateFrom) },
        { column: "DatumU", op: "lte" as const, value: `${toIsoDate(dateTill)}T23:59:59` },
        ...(variableSymbol ? [{ column: "VarSymH", op: "eq" as const, value: variableSymbol }] : []),
      ];
      return runSelect(reader, "Payments", {
        table: "Uhrady",
        columns: ["ID", "DatumU", "RelAgH", "RelIDH", "CisloH", "VarSymH", "RelAgU", "RelIDU", "CisloU", "KcU", "CmH", "CmU", "KcKRozd", "Pozn"],
        where,
        orderBy: [{ column: "DatumU" }, { column: "ID" }],
        limit,
      });
    },
  );

  host.tool(
    "pohoda_sql_extid",
    "Find POHODA documents by external id (sExtID): the extId/ids your system wrote when importing. Returns agenda id and POHODA document id.",
    {
      ids: z.string().describe("extId ids value (the idempotency key / your document identity)"),
      limit: z.number().int().min(1).optional(),
    },
    async ({ ids, limit }) =>
      runSelect(reader, "External ids", {
        table: "sExtID",
        columns: ["ID", "RefDocID", "RelAgID", "IDS", "RefExtSys", "RelZmena"],
        where: [{ column: "IDS", op: "eq", value: ids }],
        orderBy: [{ column: "ID", direction: "desc" }],
        limit,
      }),
  );

  host.tool(
    "pohoda_sql_agendas",
    "Agenda ids used in RelAg*/RelCrAg columns (2 = issued invoices, 3 = received, 27 = cash register, 28 = bank, 29 = internal documents, 31 = journal ...).",
    {},
    async () => jsonResult("Agendas", reader.dictionary.agendas, reader.dictionary.agendas.length),
  );
}

async function runSelect(reader: SqlReader, label: string, q: Parameters<SqlReader["select"]>[0]) {
  try {
    const { rows, sql } = await reader.select(q);
    return ok(`${label} (${rows.length} rows)\n\n${JSON.stringify(rows, null, 2)}\n\n-- ${sql}`);
  } catch (e) {
    return err((e as Error).message);
  }
}
