import type { PohodaClient } from "../client.js";
import type { ConnectorConfig } from "../core/config.js";
import { assertCanApprove, assertCanSend, type Principal } from "../core/principal.js";
import { parseResponse, extractImportResult } from "../xml/parser.js";
import type { OutboxStore } from "./store.js";
import type { NewProposal, Proposal, ProposalEvent, ProposalFilter, ProposalState } from "./types.js";

export class ProposalStateError extends Error {
  readonly code = "invalid_state";
}

/** Which transitions a caller may request. Everything else is refused loudly. */
const ALLOWED: Record<"approve" | "reject" | "send" | "replay", ProposalState[]> = {
  approve: ["proposed"],
  reject: ["proposed", "approved", "failed"],
  send: ["approved", "failed"],
  replay: ["sent", "refused", "failed"],
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

  private async require(id: number, action: keyof typeof ALLOWED): Promise<Proposal> {
    const proposal = await this.store.get(id);
    if (!proposal) throw new ProposalStateError(`proposal ${id} not found`);
    if (!ALLOWED[action].includes(proposal.state)) {
      throw new ProposalStateError(`cannot ${action} proposal ${id} in state "${proposal.state}" (allowed: ${ALLOWED[action].join(", ")})`);
    }
    return proposal;
  }

  async approve(id: number, principal: Principal, note?: string): Promise<Proposal> {
    assertCanApprove(principal, this.config);
    const proposal = await this.require(id, "approve");
    const approved = await this.store.update(
      id,
      { state: "approved", approvedBy: principal.name, approvedAt: new Date().toISOString(), decisionNote: note },
      { fromState: proposal.state, toState: "approved", actor: principal.name, note },
    );
    if (!this.config.autoSendOnApprove) return approved;
    return (await this.send(id, principal)).proposal;
  }

  async reject(id: number, principal: Principal, reason: string): Promise<Proposal> {
    assertCanApprove(principal, this.config);
    if (!reason.trim()) throw new Error("a rejection needs a reason");
    const proposal = await this.require(id, "reject");
    return this.store.update(
      id,
      { state: "rejected", approvedBy: principal.name, approvedAt: new Date().toISOString(), decisionNote: reason },
      { fromState: proposal.state, toState: "rejected", actor: principal.name, note: reason },
    );
  }

  async send(id: number, principal: Principal): Promise<SendOutcome> {
    assertCanSend(principal, this.config);
    const proposal = await this.require(id, "send");
    return this.transmit(proposal, principal);
  }

  /** Replay re-sends the stored XML with the same ids; POHODA's duplicity check makes this safe. */
  async replay(id: number, principal: Principal): Promise<SendOutcome> {
    assertCanSend(principal, this.config);
    const proposal = await this.require(id, "replay");
    return this.transmit(proposal, principal);
  }

  private async transmit(proposal: Proposal, principal: Principal): Promise<SendOutcome> {
    const attempts = proposal.attempts + 1;
    await this.store.update(proposal.id, { state: "sending", attempts }, { fromState: proposal.state, toState: "sending", actor: principal.name, note: `attempt ${attempts}` });

    let responseXml: string;
    try {
      responseXml = await this.client.sendXml(proposal.xml, { checkDuplicity: true, instance: proposal.datapackId });
    } catch (e) {
      const error = (e as Error).message;
      const failed = await this.store.update(proposal.id, { state: "failed", error }, { fromState: "sending", toState: "failed", actor: principal.name, note: error });
      return { proposal: failed, duplicate: false };
    }

    const parsed = parseResponse(responseXml);
    const item = parsed.items[0];
    const result = extractImportResult(parsed);
    const note = item?.note ?? result.message;
    const duplicate = !result.success && DUPLICATE_PATTERN.test(`${note} ${JSON.stringify(item?.data ?? "")}`);

    if (result.success || duplicate) {
      const sent = await this.store.update(
        proposal.id,
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
      return { proposal: sent, duplicate };
    }

    const refused = await this.store.update(
      proposal.id,
      { state: "refused", responseState: item?.state ?? parsed.state, responseNote: note, responseXml, error: note },
      { fromState: "sending", toState: "refused", actor: principal.name, note },
    );
    return { proposal: refused, duplicate: false };
  }
}
