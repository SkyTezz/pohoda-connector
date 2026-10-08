# pohoda-connector — repo map. Agents only. Rules → `CLAUDE.md`. Security → `SECURITY.md`.

<what>
Universal connector for Stormware POHODA driven by AI agents and backends. writes = mServer XML behind human approval with idempotent replay; reads = mServer exports + optional read-only SQL. two doors: MCP (stdio / Streamable HTTP) and REST `/v1`, same tools, validation and audit. MIT, fork of hlebtkachenko/pohoda-mcp (upstream tool coverage kept; documents gained pre-accounting, VAT classification, payment form, partner binding, requested numbers, foreign currency, advance deduction, liquidation, storno, corrective documents).
</what>

<layout>
`src/index.ts` → entry: config, store, units, dictionary, transport (stdio | http). `src/server.ts` → tool registry per principal.
`src/core/` → `config.ts` (env, defaults, refuses unsafe combos), `principal.ts` (roles), `write_tool.ts` (proposal gate), `identity.ts` (deterministic ids), `units.ts` (`POHODA_UNITS`), `registry.ts`, `filters.ts`, `context.ts`.
`src/tools/` → one file per agenda: `invoices`, `bank`, `vouchers`, `internal_docs`, `addresses`, `orders`, `offers`, `enquiries`, `contracts`, `stock`, `warehouse`, `production`, `reports`, `settings`, `proposals`, `sql`, `system`.
`src/xml/` → builder, parser, namespaces, Windows-1250 encoding. `src/client.ts` → mServer HTTP client.
`src/outbox/` → `service.ts` (state machine, send, replay, duplicate detection), `sqlite_store.ts`, `mssql_store.ts` (tables `proposals`, `proposal_events`).
`src/sql/` → `dictionary.ts`, `reader.ts` (single-table `SELECT TOP`, parameterised). `schema/pohoda-tables.json` (443 tables), `pohoda-agendas.json`.
`src/http/server.ts` → REST + `/mcp`, bearer auth on all but `/v1/healthz`.
`test/` → vitest: documents, identity, outbox, units, sql, http, security, hardening. `scripts/sync-dictionary.mjs` → refresh `schema/` from `../PohodaSQL` or GitHub.
`Dockerfile` (node:24-slim, `CONNECTOR_COMMIT` build arg), `docker-compose.yml` (http transport, `127.0.0.1:8444`, volume `/data`), `.github/workflows/ci.yml`.
</layout>

<flow>
WRITE: tool call → `proposed` (XML + ids frozen) → `approve` (human) → `approved` → send (auto if `CONNECTOR_AUTO_SEND_ON_APPROVE`, default true, or worker) → `sending` → `sent` (pohodaId, number) | `refused` (POHODA said no → new proposal) | `failed` (transport → replay, same ids). `reject` (human, reason) → `rejected`. every transition → `proposal_events`; request + response XML kept.
ROLES: `agent` (stdio `CONNECTOR_PRINCIPAL_ROLE=agent` or agent token) → read, list, propose. `human` (token forwarded for an operator session) → + approve / reject / send / replay. `service` (backend worker token) → read, propose, send / replay approved.
</flow>

<tools>
SYSTEM: `pohoda_connector_info` (read first: units, mServer configured?), `pohoda_status`, `pohoda_company_info`, `pohoda_download_file`.
PROPOSALS: `pohoda_proposals_list`, `pohoda_proposal_get`, `pohoda_proposal_approve` (human), `pohoda_proposal_reject` (human), `pohoda_proposal_send`, `pohoda_proposal_replay`.
WRITES (gated; every one takes `idempotencyKey` + `reason`, and `accountingUnit` when > 1 unit): `pohoda_create_invoice` (all 15 `invoiceType`s, `accounting`, `classificationVAT`, `paymentType`, `number` → `numberRequested`, `partner` with `linkToAddress` / `extId`, `foreignCurrency`, items with per-line VAT + stock links, `advancePayments`), `pohoda_create_corrective_invoice`, `pohoda_cancel_invoice`, `pohoda_create_bank` (items and/or `liquidations`), `pohoda_create_voucher`, `pohoda_cancel_voucher`, `pohoda_create_internal_doc` (e.g. §90 margin VAT), `pohoda_create_address` / `_update_address`, `pohoda_create_order`, `_offer`, `_enquiry`, `_contract`, `pohoda_create_stock` / `_update_stock`, `pohoda_create_prijemka` / `_vydejka` / `_prodejka` / `_prevodka`, `pohoda_create_vyroba`, `pohoda_create_service`. `pohoda_delete_*` refuse unless `CONNECTOR_ALLOW_DELETE=true`.
RECEIVED INVOICE (`invoiceType` `receivedInvoice` | `commitment` | `receivedAdvanceInvoice`): `originalDocument` (supplier's number) ≠ `symVar`; `dateApplicationVAT`, `dateKHDPH`, `numberKHDPH`, `paymentAccount`; header `totals {priceNone, priceLow, priceLowVAT, priceHigh, priceHighVAT}` XOR `items[]` (each own `accounting` + `classificationVAT`); `attachments [{name, url}]` → *Dokumenty* tab.
MSERVER READS: `pohoda_list_invoices`, `_bank`, `_vouchers`, `_internal_docs`, `_addresses`, `_orders`, `_offers`, `_enquiries`, `_contracts`, `_stock`, `_stores`, `_prijemky`, `_vydejky`, `_prodejky`, `_prevodky`, `_vyroba`, `_service`, `_accountancy`, `_balance`, `_movements`, `_vat`, `pohoda_list_settings` (number series, cash registers, bank accounts, centres, activities, payment forms, stores, storages, categories, units). codes used in writes → read them here first (VAT classifications need *Nabízet* ticked).
SQL READS (`POHODA_SQL_*` set): `pohoda_sql_databases`, `_tables`, `_describe`, `_select`, `_aggregate` (COUNT/SUM/MIN/MAX + GROUP BY, one table), `_journal` (pUD), `_payments` (Uhrady), `_extid` (sExtID by your key), `_agendas`. every one takes `database` (`StwPh_<IČO>_<year>`).
LINE PRICES? → unit prices; `payVAT=true` = price incl. VAT; totals computed by POHODA. not exposed: `paymentAccount` on bank headers, Intrastat / MOSS.
</tools>

<rest>
`GET /v1/healthz` (no auth) → `{ok, version, commit}`. `GET /v1/tools`. `POST /v1/tools/{name}` `{"args":{}}`. `GET /v1/proposals?state=&tool=&limit=`. `GET /v1/proposals/{id}` (XML + response + events). `POST /v1/proposals/{id}/approve {"note"}` · `/reject {"reason"}` (human) · `/send` · `/replay` (human | service). `POST /mcp` (Streamable HTTP, one session per initialize).
AUTH: bearer from `CONNECTOR_TOKENS`, token decides role. ERRORS: `{"error":{"code","message"},"request_id"}` — 400 bad args, 403 forbidden, 409 wrong proposal state, 422 tool error.
</rest>

<run>
`cp .env.example .env` → `npm ci && npm run build` → `CONNECTOR_TRANSPORT=stdio CONNECTOR_PRINCIPAL_ROLE=agent node dist/index.js` (agents) | `CONNECTOR_TRANSPORT=http node dist/index.js` | `docker compose up -d --build`.
MCP stdio client: `{"command":"node","args":["<repo>/dist/index.js"],"env":{POHODA_*, "CONNECTOR_PRINCIPAL_ROLE":"agent", "CONNECTOR_SQLITE_PATH":"…"}}`.
STORE: `CONNECTOR_STORE=sqlite` (default) | `mssql` (own DB on the POHODA SQL Server, never inside `StwPh_*`).
POHODA SIDE: one mServer configuration per unit, own port, one licence each; user needs *Datová komunikace* + *POHODA mServer* rights.
</run>

<env>
NAMES ONLY (`.env.example`). mServer single unit: `POHODA_URL`, `POHODA_USERNAME`, `POHODA_PASSWORD`, `POHODA_ICO`, `POHODA_TIMEOUT`, `POHODA_MAX_RETRIES`. several units: `POHODA_UNITS` (JSON `{"<IČO>":{"name","mserver":{url,username,password}}}`, `mserver` optional).
SQL: `POHODA_SQL_SERVER`, `_PORT`, `_DATABASE`, `_USER`, `_PASSWORD`, `_ENCRYPT`, `_TRUST_CERT`, `_MAX_ROWS`, `_ALLOWED_ICOS`.
CONNECTOR: `CONNECTOR_WRITE_MODE` (`approval` | `direct`), `_ALLOW_DELETE`, `_AUTO_SEND_ON_APPROVE`, `_SANDBOX`, `_EXT_SYSTEM`, `_STORE`, `_STORE_MSSQL`, `_SQLITE_PATH`, `_TRANSPORT`, `_PRINCIPAL_NAME`, `_PRINCIPAL_ROLE`, `_HTTP_HOST`, `_HTTP_PORT`, `_HTTP_ALLOWED_HOSTS`, `_HTTP_MAX_SESSIONS`, `_HTTP_SESSION_IDLE_MINUTES`, `_TOKENS`, `_COMMIT` (build arg).
</env>
