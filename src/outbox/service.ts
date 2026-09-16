import type { PohodaClient } from "../client.js";
import type { ConnectorConfig } from "../core/config.js";
import { assertCanApprove, assertCanSend, type Principal } from "../core/principal.js";
import { parseResponse, extractImportResult } from "../xml/parser.js";
import type { OutboxStore } from "./store.js";
import type { NewProposal, Proposal, ProposalEvent, ProposalFilter, ProposalPatch, ProposalState } from "./types.js";

export class ProposalStateError extends Error {
  readonly code = "invalid_state";
}

/**
 * Which states each request may start from. Everything else is refused loudly.
 * `sending` is replayable: a crash mid-send leaves that state behind and the
 * duplicity check on the same ids makes a second transmission safe.
 */
const ALLOWED: Record<"approve" | "reject" | "send" | "replay", readonly ProposalState[]> = {
  approve: ["proposed"],
  reject: ["proposed", "approved", "failed"],
  send: ["approved", "failed"],
  replay: ["sending", "sent", "refused", "failed"],
};

/**
 * POHODA reports a duplicate dataPack/dataPackItem id as an item-level error.
 * The wording is not part of the XSD (observed: "duplicit" in Czech responses),
 * so this is a heuristic and is recorded verbatim on the proposal for review.
 */
const DUPLICATE_PATTERN = /duplic/i;

export interface SendOutcome {
  proposal: Proposal;
  duplicate: boolean;
}

export class OutboxService {
  constructor(
    private readonly store: OutboxStore,
    private readonly config: Pick<ConnectorConfig, "sandbox" | "autoSendOnApprove">,
    private readonly client: Pick<PohodaClient, "sendXml">,
  ) {}

  /** Idempotent on `key`: the same intended write always maps to the same proposal. */
  async propose(input: NewProposal): Promise<{ proposal: Proposal; created: boolean }> {
    const existing = await this.store.findByKey(input.key);
    if (existing) return { proposal: existing, created: false };
    const proposal = await this.store.insert(input);
    return { proposal, created: true };
  }

  get(id: number): Promise<Proposal | undefined> {
    return this.store.get(id);
  }

  list(filter: ProposalFilter): Promise<Proposal[]> {
    return this.store.list(filter);
  }

  events(id: number): Promise<ProposalEvent[]> {
    return this.store.events(id);
  }

  private async move(id: number, action: keyof typeof ALLOWED, toState: ProposalState, patch: ProposalPatch, principal: Principal, note?: string): Promise<Proposal> {
    const current = await this.store.get(id);
    if (!current) throw new ProposalStateError(`proposal ${id} not found`);
    if (!ALLOWED[action].includes(current.state)) {
      throw new ProposalStateError(`cannot ${action} proposal ${id} in state "${current.state}" (allowed: ${ALLOWED[action].join(", ")})`);
    }
    const moved = await this.store.transition(id, ALLOWED[action], { ...patch, state: toState }, { fromState: current.state, toState, actor: principal.name, note });
    if (!moved) throw new ProposalStateError(`proposal ${id} was changed concurrently; reload and retry`);
    return moved;
  }

  async approve(id: number, principal: Principal, note?: string): Promise<Proposal> {
    assertCanApprove(principal, this.config);
    const approved = await this.move(id, "approve", "approved", { approvedBy: principal.name, approvedAt: new Date().toISOString(), decisionNote: note }, principal, note);
    if (!this.config.autoSendOnApprove) return approved;
    return (await this.send(id, principal)).proposal;
  }

  async reject(id: number, principal: Principal, reason: string): Promise<Proposal> {
    assertCanApprove(principal, this.config);
    if (!reason.trim()) throw new Error("a rejection needs a reason");
    return this.move(id, "reject", "rejected", { approvedBy: principal.name, approvedAt: new Date().toISOString(), decisionNote: reason }, principal, reason);
  }

  async send(id: number, principal: Principal): Promise<SendOutcome> {
    assertCanSend(principal, this.config);
    return this.transmit(id, "send", principal);
  }

  /** Replay re-sends the stored XML with the same ids; POHODA's duplicity check makes this safe. */
  async replay(id: number, principal: Principal): Promise<SendOutcome> {
    assertCanSend(principal, this.config);
    return this.transmit(id, "replay", principal);
  }

  private async transmit(id: number, action: "send" | "replay", principal: Principal): Promise<SendOutcome> {
    const before = await this.store.get(id);
    if (!before) throw new ProposalStateError(`proposal ${id} not found`);
    const attempts = before.attempts + 1;
    // Claiming the `sending` state atomically is the lock: a concurrent sender loses here, not at mServer.
    const claimed = await this.move(id, action, "sending", { attempts }, principal, `attempt ${attempts}`);

    let responseXml: string;
    try {
      responseXml = await this.client.sendXml(claimed.xml, { checkDuplicity: true, instance: claimed.datapackId });
    } catch (e) {
      const error = (e as Error).message;
      const failed = await this.store.transition(id, ["sending"], { state: "failed", error }, { fromState: "sending", toState: "failed", actor: principal.name, note: error });
      return { proposal: failed ?? claimed, duplicate: false };
    }

    const parsed = parseResponse(responseXml);
    const item = parsed.items[0];
    const result = extractImportResult(parsed);
    const note = item?.note ?? result.message;
    const duplicate = !result.success && DUPLICATE_PATTERN.test(`${note} ${JSON.stringify(item?.data ?? "")}`);

    if (result.success || duplicate) {
      const sent = await this.store.transition(
        id,
        ["sending"],
        {
          state: "sent",
          sentAt: new Date().toISOString(),
          pohodaId: result.producedId,
          pohodaNumber: result.producedNumber,
          responseState: item?.state ?? parsed.state,
          responseNote: duplicate ? `duplicate acknowledged by POHODA: ${note}` : note,
          responseXml,
          error: undefined,
        },
        { fromState: "sending", toState: "sent", actor: principal.name, note: duplicate ? "duplicate" : note },
      );
      return { proposal: sent ?? claimed, duplicate };
    }

    const refused = await this.store.transition(
      id,
      ["sending"],
      { state: "refused", responseState: item?.state ?? parsed.state, responseNote: note, responseXml, error: note },
      { fromState: "sending", toState: "refused", actor: principal.name, note },
    );
    return { proposal: refused ?? claimed, duplicate: false };
  }
}
