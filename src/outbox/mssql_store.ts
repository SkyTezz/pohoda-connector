import sql from "mssql";
import type { MssqlConnection } from "../core/config.js";
import { clampLimit, nowIso, patchColumns, rowToProposal, type OutboxStore, type ProposalRow } from "./store.js";
import type { NewProposal, Proposal, ProposalEvent, ProposalFilter, ProposalPatch, ProposalState, TransitionEvent } from "./types.js";

const SCHEMA = `
IF OBJECT_ID('dbo.proposals', 'U') IS NULL
CREATE TABLE dbo.proposals (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [key] NVARCHAR(64) NOT NULL UNIQUE,
  tool NVARCHAR(80) NOT NULL,
  kind NVARCHAR(16) NOT NULL,
  agenda NVARCHAR(40) NOT NULL,
  summary NVARCHAR(400) NOT NULL,
  args_json NVARCHAR(MAX) NOT NULL,
  xml NVARCHAR(MAX) NOT NULL,
  xml_hash NCHAR(64) NOT NULL,
  datapack_id NVARCHAR(64) NOT NULL,
  item_id NVARCHAR(64) NOT NULL,
  state NVARCHAR(16) NOT NULL,
  proposed_by NVARCHAR(120) NOT NULL,
  proposed_at NVARCHAR(40) NOT NULL,
  reason NVARCHAR(MAX) NULL,
  approved_by NVARCHAR(120) NULL,
  approved_at NVARCHAR(40) NULL,
  decision_note NVARCHAR(MAX) NULL,
  sent_at NVARCHAR(40) NULL,
  attempts INT NOT NULL DEFAULT 0,
  pohoda_id INT NULL,
  pohoda_number NVARCHAR(40) NULL,
  response_state NVARCHAR(16) NULL,
  response_note NVARCHAR(MAX) NULL,
  response_xml NVARCHAR(MAX) NULL,
  error NVARCHAR(MAX) NULL
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_proposals_state')
  CREATE INDEX ix_proposals_state ON dbo.proposals(state, id);
IF OBJECT_ID('dbo.proposal_events', 'U') IS NULL
CREATE TABLE dbo.proposal_events (
  id INT IDENTITY(1,1) PRIMARY KEY,
  proposal_id INT NOT NULL REFERENCES dbo.proposals(id),
  from_state NVARCHAR(16) NULL,
  to_state NVARCHAR(16) NOT NULL,
  actor NVARCHAR(120) NOT NULL,
  at NVARCHAR(40) NOT NULL,
  note NVARCHAR(MAX) NULL
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_proposal_events_proposal')
  CREATE INDEX ix_proposal_events_proposal ON dbo.proposal_events(proposal_id, id);
`;

/**
 * SQL Server store: the connector's own database on the same instance as
 * POHODA (never inside a StwPh_* database). The login used here needs
 * CREATE TABLE + DML on this database only.
 */
export class MssqlOutboxStore implements OutboxStore {
  private pool: sql.ConnectionPool | undefined;

  constructor(private readonly conn: MssqlConnection) {}

  async init(): Promise<void> {
    this.pool = await new sql.ConnectionPool({
      server: this.conn.server,
      port: this.conn.port,
      database: this.conn.database,
      user: this.conn.user,
      password: this.conn.password,
      options: { encrypt: this.conn.encrypt, trustServerCertificate: this.conn.trustServerCertificate },
    }).connect();
    await this.pool.request().batch(SCHEMA);
  }

  private request(): sql.Request {
    if (!this.pool) throw new Error("MssqlOutboxStore.init() was not called");
    return this.pool.request();
  }

  async findByKey(key: string): Promise<Proposal | undefined> {
    const res = await this.request().input("key", sql.NVarChar(64), key).query<ProposalRow>("SELECT * FROM dbo.proposals WHERE [key] = @key");
    return res.recordset[0] ? rowToProposal(res.recordset[0]) : undefined;
  }

  async insert(p: NewProposal): Promise<Proposal> {
    const at = nowIso();
    const res = await this.request()
      .input("key", sql.NVarChar(64), p.key)
      .input("tool", sql.NVarChar(80), p.tool)
      .input("kind", sql.NVarChar(16), p.kind)
      .input("agenda", sql.NVarChar(40), p.agenda)
      .input("summary", sql.NVarChar(400), p.summary)
      .input("args_json", sql.NVarChar(sql.MAX), JSON.stringify(p.args))
      .input("xml", sql.NVarChar(sql.MAX), p.xml)
      .input("xml_hash", sql.NChar(64), p.xmlHash)
      .input("datapack_id", sql.NVarChar(64), p.datapackId)
      .input("item_id", sql.NVarChar(64), p.itemId)
      .input("proposed_by", sql.NVarChar(120), p.proposedBy)
      .input("proposed_at", sql.NVarChar(40), at)
      .input("reason", sql.NVarChar(sql.MAX), p.reason ?? null)
      .query<{ id: number }>(
        `INSERT INTO dbo.proposals ([key], tool, kind, agenda, summary, args_json, xml, xml_hash, datapack_id, item_id,
           state, proposed_by, proposed_at, reason, attempts)
         OUTPUT INSERTED.id
         VALUES (@key, @tool, @kind, @agenda, @summary, @args_json, @xml, @xml_hash, @datapack_id, @item_id,
           'proposed', @proposed_by, @proposed_at, @reason, 0)`,
      );
    const id = res.recordset[0].id;
    await this.request()
      .input("proposal_id", sql.Int, id)
      .input("actor", sql.NVarChar(120), p.proposedBy)
      .input("at", sql.NVarChar(40), at)
      .input("note", sql.NVarChar(sql.MAX), p.reason ?? null)
      .query("INSERT INTO dbo.proposal_events (proposal_id, from_state, to_state, actor, at, note) VALUES (@proposal_id, NULL, 'proposed', @actor, @at, @note)");
    return (await this.get(id))!;
  }

  async get(id: number): Promise<Proposal | undefined> {
    const res = await this.request().input("id", sql.Int, id).query<ProposalRow>("SELECT * FROM dbo.proposals WHERE id = @id");
    return res.recordset[0] ? rowToProposal(res.recordset[0]) : undefined;
  }

  async list(filter: ProposalFilter): Promise<Proposal[]> {
    const req = this.request().input("limit", sql.Int, clampLimit(filter.limit));
    const where: string[] = [];
    if (filter.state) {
      where.push("state = @state");
      req.input("state", sql.NVarChar(16), filter.state);
    }
    if (filter.tool) {
      where.push("tool = @tool");
      req.input("tool", sql.NVarChar(80), filter.tool);
    }
    const res = await req.query<ProposalRow>(
      `SELECT TOP (@limit) * FROM dbo.proposals${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`,
    );
    return res.recordset.map(rowToProposal);
  }

  async transition(id: number, fromStates: readonly ProposalState[], patch: ProposalPatch, event: TransitionEvent): Promise<Proposal | undefined> {
    if (!this.pool) throw new Error("MssqlOutboxStore.init() was not called");
    const columns = patchColumns(patch);
    if (columns.length === 0) throw new Error("transition needs a non-empty patch");
    const tx = new sql.Transaction(this.pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const req = new sql.Request(tx).input("id", sql.Int, id);
      const sets = columns.map(([c, v], i) => {
        req.input(`p${i}`, typeof v === "number" ? sql.Int : sql.NVarChar(sql.MAX), v as number | string | null);
        return `${c} = @p${i}`;
      });
      const states = fromStates.map((s, i) => {
        req.input(`s${i}`, sql.NVarChar(16), s);
        return `@s${i}`;
      });
      const updated = await req.query(`UPDATE dbo.proposals SET ${sets.join(", ")} WHERE id = @id AND state IN (${states.join(", ")})`);
      if ((updated.rowsAffected[0] ?? 0) === 0) {
        await tx.rollback();
        return undefined;
      }
      await new sql.Request(tx)
        .input("proposal_id", sql.Int, id)
        .input("from_state", sql.NVarChar(16), event.fromState)
        .input("to_state", sql.NVarChar(16), event.toState)
        .input("actor", sql.NVarChar(120), event.actor)
        .input("at", sql.NVarChar(40), nowIso())
        .input("note", sql.NVarChar(sql.MAX), event.note ?? null)
        .query("INSERT INTO dbo.proposal_events (proposal_id, from_state, to_state, actor, at, note) VALUES (@proposal_id, @from_state, @to_state, @actor, @at, @note)");
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    return this.get(id);
  }

  async events(id: number): Promise<ProposalEvent[]> {
    const res = await this.request().input("id", sql.Int, id).query<{
      id: number;
      proposal_id: number;
      from_state: string | null;
      to_state: string;
      actor: string;
      at: string;
      note: string | null;
    }>("SELECT * FROM dbo.proposal_events WHERE proposal_id = @id ORDER BY id");
    return res.recordset.map((r) => ({
      id: r.id,
      proposalId: r.proposal_id,
      fromState: (r.from_state as ProposalEvent["fromState"]) ?? null,
      toState: r.to_state as ProposalEvent["toState"],
      actor: r.actor,
      at: r.at,
      note: r.note ?? undefined,
    }));
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = undefined;
  }
}
