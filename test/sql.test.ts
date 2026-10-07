import { describe, expect, it } from "vitest";
import { loadDictionary } from "../src/sql/dictionary.js";
import { TokenTable } from "../src/core/principal.js";
import { startHttpServer } from "../src/http/server.js";
import { ALL_UNITS, buildAggregate, buildSelect, isAllowedDatabase, parseUnitDatabase } from "../src/sql/reader.js";
import { AGENT, harness } from "./helpers.js";

const dictionary = loadDictionary();

describe("SQL read layer", () => {
  it("dictionary knows the core tables with canonical casing", () => {
    expect(dictionary.resolveTable("pud")).toBe("pUD");
    expect(dictionary.resolveTable("fa")).toBe("FA");
    expect(dictionary.resolveTable("sextid")).toBe("sExtID");
    expect(dictionary.resolveColumn("FA", "kccelkem")).toBe("KcCelkem");
    expect(dictionary.agendas.find((a) => a.id === 2)?.name_cs).toBe("Vydané faktury");
  });

  it("builds parameterised, capped SELECTs only", () => {
    const built = buildSelect(
      dictionary,
      {
        table: "fa",
        columns: ["ID", "Cislo", "VarSym", "KcCelkem", "KcLikv"],
        where: [
          { column: "VarSym", op: "eq", value: "2026000001" },
          { column: "RelTpFak", op: "in", value: [1, 2] },
          { column: "DatLikv", op: "isNull" },
        ],
        orderBy: [{ column: "Datum", direction: "desc" }],
        limit: 5000,
      },
      1000,
    );
    expect(built.text).toBe(
      "SELECT TOP (1000) [ID], [Cislo], [VarSym], [KcCelkem], [KcLikv] FROM [dbo].[FA] WHERE [VarSym] = @w0 AND [RelTpFak] IN (@w1_0, @w1_1) AND [DatLikv] IS NULL ORDER BY [Datum] DESC",
    );
    expect(built.params).toEqual([
      { name: "w0", value: "2026000001" },
      { name: "w1_0", value: 1 },
      { name: "w1_1", value: 2 },
    ]);
  });

  it("refuses unknown tables and columns", () => {
    expect(() => buildSelect(dictionary, { table: "sysobjects" }, 10)).toThrow(/unknown POHODA table/);
    expect(() => buildSelect(dictionary, { table: "FA", columns: ["Cislo; DROP TABLE FA"] }, 10)).toThrow(/unknown column/);
    expect(() => buildSelect(dictionary, { table: "FA", where: [{ column: "ID", op: "in", value: 1 }] }, 10)).toThrow(/needs a non-empty array/);
    expect(() => buildSelect(dictionary, { table: "FA", where: [{ column: "ID", op: "invalidOp" as never, value: 1 }] }, 10)).toThrow(/unsupported operator/);
  });
});

describe("SQL reads across accounting-unit databases", () => {
  const home = "StwPh_12345678_2025";

  it("qualifies the table with the database when one is given", () => {
    expect(buildSelect(dictionary, { table: "pPK", columns: ["IDS"], limit: 5 }, 100, "StwPh_12345678_2026").text).toBe(
      "SELECT TOP (5) [IDS] FROM [StwPh_12345678_2026].[dbo].[pPK] ORDER BY [ID]",
    );
  });

  it("reads the unit's other years by default, other units only when listed", () => {
    expect(parseUnitDatabase(home)).toEqual({ name: home, prefix: "StwPh", ico: "12345678", year: 2025 });
    expect(isAllowedDatabase(home, home, [])).toBe(true);
    expect(isAllowedDatabase("StwPh_12345678_2026", home, [])).toBe(true);
    expect(isAllowedDatabase("StwPh_87654321_2025", home, [])).toBe(false);
    expect(isAllowedDatabase("StwPh_87654321_2025", home, ["87654321"])).toBe(true);
    expect(isAllowedDatabase("StwPh_11111111_2025", home, ["87654321"])).toBe(false);
    expect(isAllowedDatabase("StwPh_11111111_2025", home, [ALL_UNITS])).toBe(true);
  });

  it("refuses everything that is not a unit database of the same installation", () => {
    for (const name of ["master", "StwPh_sys", "Other_12345678_2025", "StwPh_12345678_2025]; DROP TABLE FA;--", "StwPh_12345678_25", " StwPh_12345678_2026"]) {
      expect(isAllowedDatabase(name, home, [ALL_UNITS]), name).toBe(false);
    }
    // a custom-named configured database stays the only one readable
    expect(isAllowedDatabase("StwPh_12345678_2025", "Accounting", [ALL_UNITS])).toBe(false);
    expect(isAllowedDatabase("Accounting", "Accounting", [])).toBe(true);
  });
});

describe("SQL tools over REST", () => {
  it("returns rows as parseable data, with the executed SQL kept out of it", async () => {
    const sqlText = "SELECT TOP (2) [ID], [IDS] FROM [StwPh_12345678_2025].[dbo].[pPK] ORDER BY [ID]";
    const rows = [
      { ID: 1, IDS: "3Fv" },
      { ID: 2, IDS: "5Fp" },
    ];
    const token = "agent-token-agent-token-agent-token-1";
    const base = await harness({
      http: { host: "127.0.0.1", port: 0, tokens: new TokenTable(new Map([[token, AGENT]])), allowedHosts: [], maxSessions: 10, sessionIdleMs: 60_000 },
    });
    const sql = { dictionary, database: "StwPh_12345678_2025", select: async () => ({ rows, sql: sqlText }) };
    const server = await startHttpServer({ ...base.deps, sql: sql as never });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/tools/pohoda_sql_select`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ args: { table: "pPK", columns: ["ID", "IDS"], limit: 2 } }),
      });
      const body = (await res.json()) as { ok: boolean; data: unknown; text: string };
      expect(res.status).toBe(200);
      expect(body.data).toEqual(rows);
      expect(body.text).toContain(`-- ${sqlText}`);
    } finally {
      await server.close();
    }
  });
});

describe("SQL aggregates", () => {
  it("builds grouped totals with money sums as exact text", () => {
    const built = buildAggregate(
      dictionary,
      {
        table: "fa",
        groupBy: ["RelTpFak", "relpk"],
        aggregates: [
          { fn: "count", as: "n" },
          { fn: "sum", column: "KcCelkem", as: "kc" },
          { fn: "countDistinct", column: "ICO", as: "partners" },
          { fn: "max", column: "Datum", as: "last_date" },
        ],
        where: [{ column: "Datum", op: "gte", value: "2025-01-01" }],
        orderBy: [{ by: "n", direction: "desc" }],
        limit: 50,
      },
      1000,
      "StwPh_12345678_2025",
    );
    expect(built.text).toBe(
      "SELECT TOP (50) [RelTpFak], [RelPk], COUNT(*) AS [n], CONVERT(varchar(40), SUM([KcCelkem]), 2) AS [kc], COUNT(DISTINCT [ICO]) AS [partners], MAX([Datum]) AS [last_date] " +
        "FROM [StwPh_12345678_2025].[dbo].[FA] WHERE [Datum] >= @w0 GROUP BY [RelTpFak], [RelPk] ORDER BY [n] DESC",
    );
    expect(built.params).toEqual([{ name: "w0", value: "2025-01-01" }]);
  });

  it("orders by the grouping columns when no order is given and needs no GROUP BY for a grand total", () => {
    expect(buildAggregate(dictionary, { table: "pUD", groupBy: ["UMD"], aggregates: [{ fn: "sum", column: "Kc", as: "kc" }] }, 10).text).toBe(
      "SELECT TOP (10) [UMD], CONVERT(varchar(40), SUM([Kc]), 2) AS [kc] FROM [dbo].[pUD] GROUP BY [UMD] ORDER BY [UMD] ASC",
    );
    expect(buildAggregate(dictionary, { table: "FA", aggregates: [{ fn: "count", as: "n" }] }, 10).text).toBe("SELECT TOP (10) COUNT(*) AS [n] FROM [dbo].[FA]");
  });

  it("refuses unknown columns, unsafe aliases and unknown sort keys", () => {
    const agg = (q: Partial<Parameters<typeof buildAggregate>[1]>) => () => buildAggregate(dictionary, { table: "FA", aggregates: [{ fn: "count", as: "n" }], ...q }, 10);
    expect(agg({ groupBy: ["Nope"] })).toThrow(/unknown column/);
    expect(agg({ aggregates: [{ fn: "sum", as: "kc" }] })).toThrow(/needs a column/);
    expect(agg({ aggregates: [{ fn: "count", as: "n]; DROP TABLE FA;--" }] })).toThrow(/plain identifier/);
    expect(agg({ groupBy: ["ICO"], aggregates: [{ fn: "count", as: "ico" }] })).toThrow(/already used/);
    expect(agg({ aggregates: [] })).toThrow(/give 1 to/);
    expect(agg({ orderBy: [{ by: "KcCelkem" }] })).toThrow(/neither a groupBy column nor an aggregate alias/);
  });
});
