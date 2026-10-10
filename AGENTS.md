# AGENTS.md — pohoda-connector (Stormware POHODA bridge: SQL read-only + mServer XML proposals with human approval). Agents only. Root rules: `../AGENTS.md`. Design + state: `../Aurea-Shared/agents/HANDOFF-pohoda-bridge-2026-09-16.md`, runbook `RUNBOOK-pohoda-bridge-2026-09-16.md`, contract `../Aurea-Shared/api/pohoda-bridge.md`, reference `../Aurea-Shared/pohoda/`. User docs: `README.md`. Security model: `SECURITY.md`.

<what>
TypeScript MCP (stdio / Streamable HTTP) + REST `/v1/*`, fork of `hlebtkachenko/pohoda-mcp` (MIT). every write = proposal (frozen XML, deterministic `dataPack@id` / `extId` from idempotency key) → human approves → worker sends with `STW-Check-Duplicity`; nothing is deleted (storno / corrective docs). roles `agent | human | service` by token (`CONNECTOR_TOKENS`); agents never approve (except `CONNECTOR_SANDBOX=true`). reads: mServer lists + optional SQL over `StwPh_<IČO>_<year>` validated by the 443-table dictionary from `SkyTezz/PohodaSQL`. store `proposals` + `proposal_events` (sqlite default, mssql option). multi-unit via `POHODA_UNITS`; unit without `mserver` = queue.
status: code done 16. 9., runs on `.26` (API), POHODA itself not live → deploy 0; SQL `:1433` from VPN = RST (memory `pohoda-connector-live-26-api`).
</what>

<run>
dev → `npm ci && npm run build` · gate `npm run typecheck && npm test && npm run build` (in-memory sqlite + fake mServer, no POHODA needed) · dictionary refresh `npm run sync-dictionary`. run: `CONNECTOR_TRANSPORT=stdio|http node dist/index.js` or `docker compose up -d --build`. deploy → `.github/workflows/deploy-pohoda-connector.yml` → `.26`.
</run>

<rules>
WRITE WITHOUT PROPOSAL? → NEVER. agent approving in prod → NEVER. delete tools → off unless `CONNECTOR_ALLOW_DELETE=true` (owner).
AMOUNTS? → exact decimal text, verbatim into XML; float → NEVER.
SQL? → `SELECT` only, parametrised, dictionary-validated, `TOP` capped, unit databases of this installation only (`master`, `StwPh_sys`, other prefixes refused). `StwPh_sys` re-grant after POHODA upgrade.
UNEXERCISED AGAINST LIVE POHODA (cancel / corrective blocks, attachments, header totals)? → sandbox unit first; say so in the handoff.
NEW CONTROL? → test in `test/security.test.ts` / `test/hardening.test.ts` same change.
</rules>
