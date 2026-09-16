#!/usr/bin/env node
// Refresh schema/pohoda-*.json from the PohodaSQL repository (the schema authority).
// Usage: node scripts/sync-dictionary.mjs [path-to-PohodaSQL]
// Without a path it downloads from the SkyTezz/PohodaSQL main branch.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "..", "schema");
mkdirSync(target, { recursive: true });

const files = [
  ["dictionary/tables.json", "pohoda-tables.json"],
  ["dictionary/agendas.json", "pohoda-agendas.json"],
];

const local = process.argv[2] ?? path.resolve(here, "..", "..", "PohodaSQL");
if (existsSync(path.join(local, "dictionary", "tables.json"))) {
  for (const [src, dst] of files) copyFileSync(path.join(local, src), path.join(target, dst));
  console.log(`copied dictionary from ${local}`);
} else {
  const base = "https://raw.githubusercontent.com/SkyTezz/PohodaSQL/main/";
  for (const [src, dst] of files) {
    const res = await fetch(base + src);
    if (!res.ok) throw new Error(`${base + src}: HTTP ${res.status}`);
    writeFileSync(path.join(target, dst), await res.text());
  }
  console.log(`downloaded dictionary from ${base}`);
}
