# CLAUDE.md — pohoda-connector. Agents only. Map + tools + REST → `README.md`. Threat model → `SECURITY.md` (do not edit casually). Inside the Aurea workspace → also `../AGENTS.md`.

<stack>
TypeScript (Node ≥ 22.5, `node:sqlite`), MCP SDK (stdio / Streamable HTTP) + plain REST `/v1`, zod at every boundary, fast-xml-parser + xmlbuilder2 + iconv-lite (Windows-1250), `mssql` for SQL reads / MSSQL store.
Fork of hlebtkachenko/pohoda-mcp (MIT). PUBLIC repo → no hostnames, IPs, logins, IČO, tokens of any real deployment in code, tests or docs.
</stack>

<writes>
POHODA SQL WRITE? → NEVER (number series, journal, locks belong to POHODA). writes = mServer XML v2 only.
NEW WRITING TOOL? → `registerWriteTool` (`src/core/write_tool.ts`). `ctx.client.sendXml` directly → reads / exports only.
WRITE FLOW? → proposal (XML frozen, ids deterministic) → `human` approves → send. agent / service approve → 403 (`src/core/principal.ts`). enforced in code, never in prompt or config only.
IDS? → `dataPack@id`, `dataPackItem@id`, `extId` from idempotency key (`src/core/identity.ts`, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$`); omitted → hash of tool + args + unit. replay = identical XML + `STW-Check-Duplicity` → no second document.
DELETE? → off (`CONNECTOR_ALLOW_DELETE=false`). fix = storno / corrective document.
`CONNECTOR_WRITE_MODE=direct` OR `CONNECTOR_SANDBOX=true`? → test accounting unit only (config refuses `direct` without sandbox).
UNIT WITHOUT `mserver` IN `POHODA_UNITS`? → queue: proposals stay `approved`, send explains why; add `mserver` later, frozen XML is sent as approved.
XML ELEMENT NAME? → read Stormware XSD (`stormware.cz/xml/schema/version_2/`). guess → NEVER.
MONEY? → exact decimal text end to end (`"70.58"`), never through float; SQL sums returned as text.
NOT YET PROVEN ON LIVE POHODA? → `cancelDocument` / `correctiveDocument`, header `totals`, `attachments`, MSSQL store, duplicity wording (`/duplic/i`, not in XSD) → sandbox unit first.
</writes>

<reads>
SQL? → read-only login (`SELECT` on `StwPh_<IČO>_<year>` + `StwPh_sys`), parameterised, table/column validated against `schema/pohoda-tables.json` (443 tables, from SkyTezz/PohodaSQL via `npm run sync-dictionary`), `TOP` capped (`POHODA_SQL_MAX_ROWS`, default 1000). JOIN → not supported → join client-side; page by `ID`.
WHICH DATABASES? → `POHODA_SQL_ALLOWED_ICOS`: empty = configured unit's other years; IČO list = those units; `*` = every unit. `master`, `StwPh_sys` as target, other prefixes → refused.
POHODA UPGRADE? → recreates `StwPh_sys` → re-grant the read login.
SQL-ONLY DEPLOYMENT (no unit configured)? → mServer tools are not registered → nothing can be sent.
</reads>

<verify>
GATE? → `npm run typecheck && npm test && npm run build` (vitest, in-memory SQLite + fake mServer; CI Node 22 + 24). baseline counts before, delta after.
SECURITY CONTROL CHANGED? → its test in `test/security.test.ts` / `test/hardening.test.ts` must change with it + `SECURITY.md` row.
RUNNING BUILD? → `GET /v1/healthz` → `{ok, version, commit}`; `commit` = image build arg `CONNECTOR_COMMIT` → proves which code runs.
</verify>

<aurea>
AUREA INSTANCE? → deployed from the private PROJEKT repo (workflow `deploy-pohoda-connector.yml`, no SSH); state + rules → PROJEKT `CLAUDE.md` and `Aurea-Shared/agents/HANDOFF-pohoda-connector-live-2026-10-07.md`. its details never land here.
APPROVER? → the owner. agents never use a `human` token.
</aurea>
