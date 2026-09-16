import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The POHODA table dictionary, generated in the PohodaSQL repository
 * (`tools/gen_dictionary.py` over 443 probed tables) and vendored here as
 * `schema/pohoda-tables.json`. It is the allow-list for every SQL read:
 * unknown table or column = refused before any query is built.
 */
export interface ColumnDef {
  type: string;
  size: number | string | null;
  default: unknown;
}

export interface TableDef {
  class: string | null;
  template: string | null;
  columns: Record<string, ColumnDef>;
}

export interface AgendaDef {
  id: number;
  name_en: string;
  name_cs: string;
}

export class Dictionary {
  private readonly byLower: Map<string, string>;

  constructor(
    readonly tables: Record<string, TableDef>,
    readonly agendas: AgendaDef[],
  ) {
    this.byLower = new Map(Object.keys(tables).map((t) => [t.toLowerCase(), t]));
  }

  /** Canonical table name (SQL Server collations may be case-sensitive; POHODA mixes `pUD`, `SKz`, `sCRady`). */
  resolveTable(name: string): string {
    const canonical = this.byLower.get(name.toLowerCase());
    if (!canonical) throw new Error(`unknown POHODA table "${name}" (not in the dictionary)`);
    return canonical;
  }

  resolveColumn(table: string, column: string): string {
    const def = this.tables[table];
    const match = Object.keys(def.columns).find((c) => c.toLowerCase() === column.toLowerCase());
    if (!match) throw new Error(`unknown column "${column}" on ${table}`);
    return match;
  }

  columns(table: string): Record<string, ColumnDef> {
    return this.tables[table].columns;
  }

  tableNames(): string[] {
    return Object.keys(this.tables);
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function loadDictionary(root = packageRoot()): Dictionary {
  const tables = JSON.parse(readFileSync(path.join(root, "schema", "pohoda-tables.json"), "utf-8")) as Record<string, TableDef>;
  const agendas = JSON.parse(readFileSync(path.join(root, "schema", "pohoda-agendas.json"), "utf-8")) as AgendaDef[];
  if (Object.keys(tables).length === 0) throw new Error("schema/pohoda-tables.json is empty");
  return new Dictionary(tables, agendas);
}
