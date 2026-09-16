# Security

This connector sits between AI agents / backends and an accounting system. The
threat model assumes agents are **untrusted callers**: they may be wrong,
prompt-injected or malicious, and must still be unable to change the books
without a human.

## Controls (each one is covered by a test in `test/security.test.ts` or `test/outbox.test.ts`)

| Threat | Control | Where |
|---|---|---|
| Agent writes to POHODA on its own | Every write tool is a *proposal*; `approve` requires a `human` principal; `agent`/`service` get 403. `CONNECTOR_WRITE_MODE=direct` is refused unless `CONNECTOR_SANDBOX=true`. | `core/write_tool.ts`, `core/principal.ts`, `core/config.ts` |
| Duplicate documents after retries/timeouts | `dataPack@id`, `dataPackItem@id`, `extId` derived from an idempotency key; `STW-Check-Duplicity` on every send; replay re-sends identical XML | `core/identity.ts`, `outbox/service.ts` |
| Two operators approve/send at once | Atomic `UPDATE … WHERE state IN (…)` transitions (SQLite `BEGIN IMMEDIATE`, SQL Server serializable transaction); the loser gets 409 | `outbox/sqlite_store.ts`, `outbox/mssql_store.ts` |
| Irreversible deletes | `pohoda_delete_*` refuse unless `CONNECTOR_ALLOW_DELETE=true`; storno/corrective documents instead | `core/write_tool.ts` |
| Token guessing / timing leaks | Tokens ≥ 32 chars, looked up by SHA-256 digest with `timingSafeEqual` over all entries, no early exit; `__proto__`/`constructor` keys refused | `core/principal.ts`, `core/config.ts` |
| Anonymous HTTP access | Everything except `GET /v1/healthz` needs a bearer token; HTTP transport refuses to start without tokens | `http/server.ts`, `core/config.ts` |
| DNS rebinding | Optional Host allow-list for REST + MCP (`CONNECTOR_HTTP_ALLOWED_HOSTS`); required when binding off loopback | `http/server.ts`, `core/config.ts` |
| Session hijack / exhaustion | MCP session pinned to the principal that created it; `CONNECTOR_HTTP_MAX_SESSIONS`; idle eviction | `http/server.ts` |
| Oversized / malformed bodies | 4 MiB cap (declared and streamed), JSON errors → 400, `Cache-Control: no-store` | `http/server.ts` |
| Internal detail leakage | 500s are redacted (`internal error, see server log for request <id>`); details + stack go to stderr with the request id | `http/server.ts` |
| SQL injection via read tools | Tables/columns validated against the vendored dictionary (allow-list, canonical casing), values always bound, `TOP` cap; only `SELECT` is ever built | `sql/reader.ts` |
| XML injection | Element names are constants; user text goes through xmlbuilder2 escaping; document ids validated (`[A-Za-z0-9._:-]{1,48}`) | `xml/common.ts`, `core/identity.ts` |
| Silent data corruption (Windows-1250) | Characters outside the code page are refused at proposal time and at send time instead of being replaced by `?` | `xml/encoding.ts` |
| Proposal data at rest | SQLite file and directory created owner-only (0600/0700); SQL Server store lives in its own database, never in `StwPh_*` | `outbox/sqlite_store.ts` |
| Path traversal on file download | Normalised path, `..`/absolute rejected | `client.ts` |
| Vulnerable dependencies | `npm audit --omit=dev` = 0 at release; CI runs on Node 22 and 24 | CI |

## Deployment rules

- Run behind TLS (reverse proxy) when not on the same host as the caller; the connector itself speaks plain HTTP.
- Bind to loopback or a private interface; set `CONNECTOR_HTTP_ALLOWED_HOSTS` whenever not loopback.
- One token per caller, roles minimal: agents `agent`, operator UI backend `human`, send workers `service`.
- The POHODA user for mServer needs only *Datová komunikace* + *POHODA mServer*; the SQL login only `SELECT`.
- Never put `CONNECTOR_WRITE_MODE=direct` or `CONNECTOR_SANDBOX=true` on a production accounting unit.
- Logs contain principals, request ids, paths and errors — never tokens, passwords or document bodies.

## Not covered (known)

- mServer responses are parsed with fast-xml-parser entity processing enabled; the server is trusted.
- No rate limiting per principal; put one in the reverse proxy if agents are many.
- Duplicate detection on replay matches POHODA's error note textually (`/duplic/i`); verify the wording on your POHODA version.

## Reporting

Open a private security advisory on GitHub or e-mail the repository owner. Do not file public issues for
vulnerabilities.
