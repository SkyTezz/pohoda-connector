import type { NewProposal, Proposal, ProposalEvent, ProposalFilter, ProposalPatch, ProposalState, TransitionEvent } from "./types.js";

/**
 * Durable storage for proposals. Two implementations: SQLite (single file,
 * zero infrastructure — default) and SQL Server (when the connector lives next
 * to the POHODA database). Both keep an append-only event table.
 */
export interface OutboxStore {
  init(): Promise<void>;
  findByKey(key: string): Promise<Proposal | undefined>;
  insert(proposal: NewProposal): Promise<Proposal>;
  get(id: number): Promise<Proposal | undefined>;
  list(filter: ProposalFilter): Promise<Proposal[]>;
  /**
   * Atomic state transition: applies `patch` + records `event` only if the row
   * is currently in one of `fromStates` (UPDATE … WHERE state IN …). Returns
   * undefined when another caller moved the row first, so two operators
   * approving at once can never both send.
   */
  transition(id: number, fromStates: readonly ProposalState[], patch: ProposalPatch, event: TransitionEvent): Promise<Proposal | undefined>;
  events(id: number): Promise<ProposalEvent[]>;
  close(): Promise<void>;
}

export const MAX_LIST_LIMIT = 200;
export const DEFAULT_LIST_LIMIT = 50;

export function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return Math.min(limit, MAX_LIST_LIMIT);
}

/** Shared row shape between the two stores so mapping code is written once. */
export interface ProposalRow {
  id: number;
  key: string;
  tool: string;
  kind: string;
  agenda: string;
  summary: string;
  args_json: string;
  xml: string;
  xml_hash: string;
  datapack_id: string;
  item_id: string;
  state: string;
  proposed_by: string;
  proposed_at: string;
  reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  decision_note: string | null;
  sent_at: string | null;
  attempts: number;
  pohoda_id: number | null;
  pohoda_number: string | null;
  response_state: string | null;
  response_note: string | null;
  response_xml: string | null;
  error: string | null;
}

export function rowToProposal(row: ProposalRow): Proposal {
  return {
    id: Number(row.id),
    key: row.key,
    tool: row.tool,
    kind: row.kind as Proposal["kind"],
    agenda: row.agenda,
    summary: row.summary,
    args: JSON.parse(row.args_json),
    xml: row.xml,
    xmlHash: row.xml_hash,
    datapackId: row.datapack_id,
    itemId: row.item_id,
    state: row.state as Proposal["state"],
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    reason: row.reason ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    decisionNote: row.decision_note ?? undefined,
    sentAt: row.sent_at ?? undefined,
    attempts: Number(row.attempts),
    pohodaId: row.pohoda_id ?? undefined,
    pohodaNumber: row.pohoda_number ?? undefined,
    responseState: row.response_state ?? undefined,
    responseNote: row.response_note ?? undefined,
    responseXml: row.response_xml ?? undefined,
    error: row.error ?? undefined,
  };
}

const PATCH_COLUMNS: Record<keyof ProposalPatch, string> = {
  state: "state",
  approvedBy: "approved_by",
  approvedAt: "approved_at",
  decisionNote: "decision_note",
  sentAt: "sent_at",
  attempts: "attempts",
  pohodaId: "pohoda_id",
  pohodaNumber: "pohoda_number",
  responseState: "response_state",
  responseNote: "response_note",
  responseXml: "response_xml",
  error: "error",
};

/** Turn a patch into (column, value) pairs in a fixed order — same for both stores. */
export function patchColumns(patch: ProposalPatch): Array<[string, unknown]> {
  return (Object.keys(PATCH_COLUMNS) as Array<keyof ProposalPatch>)
    .filter((k) => patch[k] !== undefined)
    .map((k) => [PATCH_COLUMNS[k], patch[k]]);
}

export function nowIso(): string {
  return new Date().toISOString();
}
