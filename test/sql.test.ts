import { describe, expect, it } from "vitest";
import { loadDictionary } from "../src/sql/dictionary.js";
import { buildSelect } from "../src/sql/reader.js";

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
          { column: "VarSym", op: "eq", value: "2026002987" },
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
      { name: "w0", value: "2026002987" },
      { name: "w1_0", value: 1 },
      { name: "w1_1", value: 2 },
    ]);
  });

  it("refuses unknown tables and columns", () => {
    expect(() => buildSelect(dictionary, { table: "sysobjects" }, 10)).toThrow(/unknown POHODA table/);
    expect(() => buildSelect(dictionary, { table: "FA", columns: ["Cislo; DROP TABLE FA"] }, 10)).toThrow(/unknown column/);
    expect(() => buildSelect(dictionary, { table: "FA", where: [{ column: "ID", op: "in", value: 1 }] }, 10)).toThrow(/needs a non-empty array/);
  });
});
