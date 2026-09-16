/**
 * Proposal = one intended write into POHODA, frozen as the exact XML that will
 * be sent, with deterministic ids. It is the unit of approval, sending, replay
 * and audit. Nothing here is ever deleted; state moves forward and every move
 * is an event.
 */
export type ProposalState =
  | "proposed" // waiting for a human
  | "approved" // human said yes, not yet sent
  | "rejected" // human said no (terminal)
  | "sending" // in flight to mServer
  | "sent" // POHODA accepted (or reported the item as an already-known duplicate)
  | "refused" // POHODA answered with an error for this item (needs a new proposal)
  | "failed"; // transport failure, retry allowed with the same ids

export type ProposalKind = "create" | "update" | "delete";

export interface Proposal {
  id: number;
  /** Idempotency key = dataPackItem@id = extId/ids. Unique. */
  key: string;
  tool: string;
  kind: ProposalKind;
  agenda: string;
  summary: string;
  args: unknown;
  xml: string;
  xmlHash: string;
  datapackId: string;
  itemId: string;
  state: ProposalState;
  proposedBy: string;
  proposedAt: string;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
  decisionNote?: string;
  sentAt?: string;
  attempts: number;
  pohodaId?: number;
  pohodaNumber?: string;
  responseState?: string;
  responseNote?: string;
  responseXml?: string;
  error?: string;
}

export interface NewProposal {
  key: string;
  tool: string;
  kind: ProposalKind;
  agenda: string;
  summary: string;
  args: unknown;
  xml: string;
  xmlHash: string;
  datapackId: string;
  itemId: string;
  proposedBy: string;
  reason?: string;
}

export interface ProposalEvent {
  id: number;
  proposalId: number;
  fromState: ProposalState | null;
  toState: ProposalState;
  actor: string;
  at: string;
  note?: string;
}

export interface ProposalPatch {
  state?: ProposalState;
  approvedBy?: string;
  approvedAt?: string;
  decisionNote?: string;
  sentAt?: string;
  attempts?: number;
  pohodaId?: number;
  pohodaNumber?: string;
  responseState?: string;
  responseNote?: string;
  responseXml?: string;
  error?: string;
}

export interface ProposalFilter {
  state?: ProposalState;
  tool?: string;
  limit?: number;
}

export interface TransitionEvent {
  fromState: ProposalState | null;
  toState: ProposalState;
  actor: string;
  note?: string;
}
