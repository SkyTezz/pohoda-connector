# pohoda-connector

Universal connector for [Stormware POHODA](https://www.stormware.cz/pohoda/) that AI agents and backends can drive safely:

- **Writes go through a human.** In the default `approval` mode every `pohoda_create_*` / `update` / `cancel` call
  becomes a *proposal* — the exact XML that will be sent, frozen with deterministic ids. A human approves it (REST or
  MCP); a worker sends it. Agents and service tokens can propose and read, never approve. Enforced in code.
- **Redoable.** `dataPack@id`, `dataPackItem@id` and `extId` are derived from an idempotency key (yours, or a hash of the
  call). Replaying a proposal after a timeout re-sends the identical XML with `STW-Check-Duplicity`; POHODA's own
  duplicity check guarantees no second document. Nothing is ever deleted — storno and corrective documents instead.
- **Reads two ways.** mServer XML exports (`pohoda_list_*`) plus optional **read-only SQL** over the accounting-unit
  database, validated against the 443-table dictionary generated in [SkyTezz/PohodaSQL](https://github.com/SkyTezz/PohodaSQL).
- **Two doors.** MCP (stdio or Streamable HTTP) for agents; plain REST (`/v1/...`) for the application that hosts the
  approval UI. Same tools, same validation, same audit trail.

Fork of [hlebtkachenko/pohoda-mcp](https://github.com/hlebtkachenko/pohoda-mcp) (MIT). Upstream tool coverage is kept;
invoices, bank, cash vouchers and internal documents gained pre-accounting, VAT classification, payment form, partner
binding, requested numbers, foreign currency, advance-invoice deduction, liquidation (paying invoices), storno and
corrective documents.

## How a write flows

```
agent/backend ──pohoda_create_invoice──▶ proposal (state=proposed, xml frozen, ids deterministic)
                                            │
human (interni, MCP or REST) ─approve─▶ approved ──send (auto or worker)──▶ sending ──▶ sent (pohodaId, number)
                                            │                                    ├──▶ refused (POHODA said no; new proposal)
                                            └─reject (reason)─▶ rejected         └──▶ failed (transport; replay with same ids)
```

Every transition is an event (`proposal_events`), every proposal keeps the request XML and POHODA's response XML.

## Roles

| Role | From | May |
|---|---|---|
| `agent` | MCP stdio (`CONNECTOR_PRINCIPAL_ROLE=agent`) or an agent token | read, list proposals, **propose** |
| `human` | a token the calling application forwards for an operator session | everything above + **approve / reject / send / replay** |
| `service` | a backend worker token | read, propose, **send / replay** approved proposals |

`CONNECTOR_SANDBOX=true` (test accounting unit only) lets agents approve so renderers can be tested end to end.

## Tools

System: `pohoda_connector_info` (read first), `pohoda_status`, `pohoda_company_info`, `pohoda_download_file`.

Proposals: `pohoda_proposals_list`, `pohoda_proposal_get`, `pohoda_proposal_approve` (human), `pohoda_proposal_reject`
(human), `pohoda_proposal_send`, `pohoda_proposal_replay`.

Documents (every create/update/cancel is gated): `pohoda_create_invoice` (all 15 `invoiceType`s, `accounting`,
`classificationVAT`, `paymentType`, `number` = `numberRequested`, `partner` with `linkToAddress`/`extId`,
`foreignCurrency`, items with per-line VAT classification and stock links, `advancePayments`),
`pohoda_create_corrective_invoice`, `pohoda_cancel_invoice`, `pohoda_create_bank` (items and/or `liquidations` of
invoices by number/id/extId), `pohoda_create_voucher` (cash register, items, `liquidations`), `pohoda_cancel_voucher`,
`pohoda_create_internal_doc` (e.g. §90 margin VAT), `pohoda_create_address` / `pohoda_update_address`,
`pohoda_create_order`, `pohoda_create_offer`, `pohoda_create_enquiry`, `pohoda_create_contract`, `pohoda_create_stock` /
`pohoda_update_stock`, `pohoda_create_prijemka` / `vydejka` / `prodejka` / `prevodka`, `pohoda_create_vyroba`,
`pohoda_create_service`. `pohoda_delete_*` exist but refuse unless `CONNECTOR_ALLOW_DELETE=true`.

Reads via mServer: `pohoda_list_invoices`, `_bank`, `_vouchers`, `_internal_docs`, `_addresses`, `_orders`, `_offers`,
`_enquiries`, `_contracts`, `_stock`, `_stores`, `_prijemky`, `_vydejky`, `_prodejky`, `_prevodky`, `_vyroba`,
`_service`, `_accountancy`, `_balance`, `_movements`, `_vat`, `pohoda_list_settings` (number series, cash registers,
bank accounts, centres, activities, payment forms, stores, storages, categories, accounting units).

Reads via SQL (when `POHODA_SQL_*` is set): `pohoda_sql_databases`, `pohoda_sql_tables`, `pohoda_sql_describe`,
`pohoda_sql_select` (parameterised, dictionary-validated, `TOP` capped), `pohoda_sql_aggregate` (COUNT/SUM/MIN/MAX
with GROUP BY over one table; money sums as exact decimal text), `pohoda_sql_journal` (pUD), `pohoda_sql_payments`
(Uhrady), `pohoda_sql_extid` (sExtID lookup by your key), `pohoda_sql_agendas`.

POHODA keeps one database per accounting unit and year (`StwPh_<IČO>_<year>`). `POHODA_SQL_DATABASE` is the default;
every SQL tool takes `database` to read another one. Which ones is decided by `POHODA_SQL_ALLOWED_ICOS`: empty = the
configured unit's other years, a comma-separated list of IČO = those units, `*` = every unit of the installation.
Anything that is not a unit database of the same installation (`master`, `StwPh_sys`, another prefix) is refused.

**SQL-only deployment:** configure no accounting unit. The connector starts with SQL reads and the proposal tools
only; tools that need mServer are not registered, so nothing can be sent to a server that is not there.

## Several accounting units

POHODA runs one mServer configuration per accounting unit, each on its own port. One connector serves them all:

```
POHODA_UNITS={"12345678":{"name":"First s.r.o.","mserver":{"url":"http://pohoda-host:444","username":"…","password":"…"}},"87654321":{"name":"Second a.s."}}
```

Every mServer tool then takes `accountingUnit` (the IČO; optional only when a single unit is configured), builds the
document for that unit and talks to that unit's mServer. `pohoda_connector_info` lists the units and whether their
mServer is configured. The single-unit variables (`POHODA_URL`, `POHODA_USERNAME`, `POHODA_PASSWORD`, `POHODA_ICO`)
still work and describe one unit.

**A unit without `mserver` is a queue.** Its documents are proposed and approved as usual and stay `approved`; sending
says why it cannot (`mServer of accounting unit … is not configured`). Add the unit's `mserver` and send them — the
frozen XML and its ids are the ones that were approved. Useful when mServer runs only in a time window, or not yet.

A proposal belongs to one unit. The same arguments for two units are two documents; an explicit `idempotencyKey`
belongs to the unit that used it first.

## Received invoices

`pohoda_create_invoice` with `invoiceType: "receivedInvoice"` (or `commitment`, `receivedAdvanceInvoice`):

- `originalDocument` = the supplier's own invoice number, `symVar` = the payment symbol (they often differ),
  `dateApplicationVAT`, `dateKHDPH`, `numberKHDPH`, `paymentAccount` = the supplier's bank account.
- **Header totals instead of items** — `totals: {priceNone, priceLow, priceLowVAT, priceHigh, priceHighVAT}` books a
  document without lines, the way most received invoices are entered by hand. Do not combine with `items`.
- **Split over lines** — `items[]`, each with its own `accounting` and `classificationVAT`, when one document is
  booked to several accounts.
- Amounts may be exact decimal text (`"70.58"`); text is sent verbatim, never through a float.
- `attachments: [{name, url}]` puts links on the document's *Dokumenty* tab (e.g. the stored scan).

The XML these produce validates against Stormware's published `data.xsd`; importing attachments and header totals
has not yet been exercised against a live POHODA — verify on a sandbox unit first.

Every write tool accepts `idempotencyKey` (1-48 chars `[A-Za-z0-9._:-]`, e.g. `order-invoice:2026000001:r1`) and
`reason` (shown to the approver).

## REST

```
GET  /v1/healthz                       no auth
GET  /v1/tools                         list tools for this principal
POST /v1/tools/{name}     {"args":{}}  invoke any tool (validated with the same zod schema)
GET  /v1/proposals?state=&tool=&limit=
GET  /v1/proposals/{id}                full proposal + XML + POHODA response + events
POST /v1/proposals/{id}/approve  {"note"}      human
POST /v1/proposals/{id}/reject   {"reason"}    human
POST /v1/proposals/{id}/send                   human | service
POST /v1/proposals/{id}/replay                 human | service
POST /mcp                              MCP Streamable HTTP (one session per initialize)
```

Bearer tokens come from `CONNECTOR_TOKENS`; the token decides the role. Errors: `{"error":{"code","message"},"request_id"}`
(403 forbidden, 409 invalid proposal state, 400 bad arguments, 422 tool error).

## Run

```bash
cp .env.example .env   # fill POHODA_* and CONNECTOR_TOKENS
npm ci && npm run build
# agents over stdio (Claude Desktop / Claude Code):
CONNECTOR_TRANSPORT=stdio CONNECTOR_PRINCIPAL_ROLE=agent node dist/index.js
# backends + agents over HTTP:
CONNECTOR_TRANSPORT=http node dist/index.js
# or
docker compose up -d --build
```

MCP client config (stdio):

```json
{ "mcpServers": { "pohoda": { "command": "node", "args": ["/opt/pohoda-connector/dist/index.js"], "env": { "POHODA_URL": "http://pohoda-host:444", "POHODA_USERNAME": "…", "POHODA_PASSWORD": "…", "POHODA_ICO": "12345678", "CONNECTOR_PRINCIPAL_ROLE": "agent", "CONNECTOR_SQLITE_PATH": "/var/lib/pohoda-connector/connector.sqlite" } } } }
```

### Proposal store

`CONNECTOR_STORE=sqlite` (default, one file, Node's built-in `node:sqlite`) or `CONNECTOR_STORE=mssql` — its own
database on the same SQL Server as POHODA (never inside a `StwPh_*` database). Both keep the same two tables
(`proposals`, `proposal_events`).

### POHODA prerequisites

- mServer configuration for the accounting unit (Účetní jednotky › Databáze › POHODA mServer); the user needs
  *Datová komunikace* and *POHODA mServer* rights. One running mServer configuration occupies one POHODA licence.
- For SQL reads: a SQL Server login with `SELECT` only on `StwPh_<ICO>_<year>` (and `StwPh_sys`). POHODA recreates
  `StwPh_sys` on upgrades — re-grant afterwards.
- Codes used in mappings (number series, cash registers, bank accounts, pre-accounting, VAT classifications with
  *Nabízet* ticked) live in POHODA; read them with `pohoda_list_settings` / `pohoda_list_vat` before writing.

## Development

```bash
npm run typecheck && npm test && npm run build
npm run sync-dictionary        # refresh schema/*.json from ../PohodaSQL or GitHub
```

Tests use an in-memory SQLite store and a fake mServer; no POHODA needed. XSD element names come from
`stormware.cz/xml/schema/version_2/` (invoice, bank, voucher, intDoc, addressbook, stock, type, filter, list).

## Known limits / verify on a sandbox unit first

- `cancelDocument` / `correctiveDocument` blocks are built per XSD but were not yet exercised against a live POHODA.
- The duplicate detection on replay matches POHODA's error note against `/duplic/i`; the wording is not part of the XSD.
- Line prices are unit prices; `payVAT=true` means the price includes VAT. Totals are computed by POHODA.
- `paymentAccount` (partner's bank account on bank/invoice headers) and Intrastat/MOSS blocks are not exposed.

MIT — see LICENSE.

## Security

Threat model, controls and deployment rules: [SECURITY.md](SECURITY.md). Every control has a test in `test/security.test.ts` / `test/hardening.test.ts`.
