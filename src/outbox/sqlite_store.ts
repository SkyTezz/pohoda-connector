import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { clampLimit, nowIso, patchColumns, rowToProposal, type OutboxStore, type ProposalRow } from "./store.js";
import type { NewProposal, Proposal, ProposalEvent, ProposalFilter, ProposalPatch, ProposalState, TransitionEvent } from "./types.js";

/** Proposals carry customer data (names, amounts); the file is owner-only. No-op on Windows ACLs. */
const OWNER_ONLY = 0o600;
const IN_MEMORY = ":memory:";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  agenda TEXT NOT NULL,
  summary TEXT NOT NULL,
  args_json TEXT NOT NULL,
  xml TEXT NOT NULL,
  xml_hash TEXT NOT NULL,
  datapack_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  reason TEXT,
  approved_by TEXT,
  approved_at TEXT,
  decision_note TEXT,
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  pohoda_id INTEGER,
  pohoda_number TEXT,
  response_state TEXT,
  response_note TEXT,
  response_xml TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_proposals_state ON proposals(state, id);
CREATE TABLE IF NOT EXISTS proposal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS ix_proposal_events_proposal ON proposal_events(proposal_id, id);
`;

/** SQLite via the Node built-in module: no native build, one file, fine for a single connector process. */
export class SqliteOutboxStore implements OutboxStore {
  private db: DatabaseSync | undefined;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    const onDisk = this.filePath !== IN_MEMORY;
    if (onDisk) mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    if (onDisk) chmodSync(this.filePath, OWNER_ONLY);
  }

  private conn(): DatabaseSync {
    if (!this.db) throw new Error("SqliteOutboxStore.init() was not called");
    return this.db;
  }

  async findByKey(key: string): Promise<Proposal | undefined> {
    const row = this.conn().prepare("SELECT * FROM proposals WHERE key = ?").get(key) as ProposalRow | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  async insert(p: NewProposal): Promise<Proposal> {
    const db = this.conn();
    const at = nowIso();
    const result = db
      .prepare(
        `INSERT INTO proposals (key, tool, kind, agenda, summary, args_json, xml, xml_hash, datapack_id, item_id,
           state, proposed_by, proposed_at, reason, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, 0)`,
      )
      .run(p.key, p.tool, p.kind, p.agenda, p.summary, JSON.stringify(p.args), p.xml, p.xmlHash, p.datapackId, p.itemId, p.proposedBy, at, p.reason ?? null);
    const id = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO proposal_events (proposal_id, from_state, to_state, actor, at, note) VALUES (?, NULL, 'proposed', ?, ?, ?)").run(
      id,
      p.proposedBy,
      at,
      p.reason ?? null,
    );
    return (await this.get(id))!;
  }

  async get(id: number): Promise<Proposal | undefined> {
    const row = this.conn().prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  async list(filter: ProposalFilter): Promise<Proposal[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.state) {
      where.push("state = ?");
      params.push(filter.state);
    }
    if (filter.tool) {
      where.push("tool = ?");
      params.push(filter.tool);
    }
    const sql = `SELECT * FROM proposals${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    params.push(clampLimit(filter.limit));
    const rows = this.conn().prepare(sql).all(...(params as Array<string | number>)) as unknown as ProposalRow[];
    return rows.map(rowToProposal);
  }

  async transition(id: number, fromStates: readonly ProposalState[], patch: ProposalPatch, event: TransitionEvent): Promise<Proposal | undefined> {
    const db = this.conn();
    const columns = patchColumns(patch);
    if (columns.length === 0) throw new Error("transition needs a non-empty patch");
    const sets = columns.map(([c]) => `${c} = ?`).join(", ");
    const placeholders = fromStates.map(() => "?").join(", ");
    // BEGIN IMMEDIATE takes the write lock up front so the UPDATE + event insert are one unit.
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(`UPDATE proposals SET ${sets} WHERE id = ? AND state IN (${placeholders})`)
        .run(...(columns.map(([, v]) => v) as Array<string | number | null>), id, ...fromStates);
      if (Number(result.changes) === 0) {
        db.exec("ROLLBACK");
        return undefined;
      }
      db.prepare("INSERT INTO proposal_events (proposal_id, from_state, to_state, actor, at, note) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        event.fromState,
        event.toState,
        event.actor,
        nowIso(),
        event.note ?? null,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return this.get(id);
  }

  async events(id: number): Promise<ProposalEvent[]> {
    const rows = this.conn().prepare("SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY id").all(id) as unknown as Array<{
      id: number;
      proposal_id: number;
      from_state: string | null;
      to_state: string;
      actor: string;
      at: string;
      note: string | null;
    }>;
    return rows.map((r) => ({
      id: Number(r.id),
      proposalId: Number(r.proposal_id),
      fromState: (r.from_state as ProposalEvent["fromState"]) ?? null,
      toState: r.to_state as ProposalEvent["toState"],
      actor: r.actor,
      at: r.at,
      note: r.note ?? undefined,
    }));
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
