import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { ok, err } from "../core/types.js";

const stateEnum = z.enum(["proposed", "approved", "rejected", "sending", "sent", "refused", "failed"]);

/**
 * The approval surface. Agents list and inspect; humans approve/reject;
 * humans or service workers send/replay. Role checks live in OutboxService.
 */
export function registerProposalTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_proposals_list",
    "List proposed writes to POHODA (the approval queue). Filter by state and tool. Newest first.",
    {
      state: stateEnum.optional().describe("proposed | approved | rejected | sending | sent | refused | failed"),
      tool: z.string().optional().describe("Only proposals created by this tool, e.g. pohoda_create_invoice"),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)"),
    },
    async (params) => {
      try {
        const rows = await ctx.outbox.list(params);
        const compact = rows.map((p) => ({
          id: p.id,
          state: p.state,
          tool: p.tool,
          kind: p.kind,
          summary: p.summary,
          key: p.key,
          proposedBy: p.proposedBy,
          proposedAt: p.proposedAt,
          approvedBy: p.approvedBy,
          pohodaId: p.pohodaId,
          error: p.error,
        }));
        return ok(`Proposals (${compact.length})\n\n${JSON.stringify(compact, null, 2)}`);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_proposal_get",
    "Show one proposal in full: arguments, the exact XML that will be (or was) sent, POHODA's response and the event history.",
    { id: z.number().int().describe("Proposal id") },
    async ({ id }) => {
      try {
        const proposal = await ctx.outbox.get(id);
        if (!proposal) return err(`proposal ${id} not found`);
        const events = await ctx.outbox.events(id);
        return ok(JSON.stringify({ ...proposal, events }, null, 2));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_proposal_approve",
    "Approve a proposal. HUMAN ONLY — agents and service tokens are refused. With CONNECTOR_AUTO_SEND_ON_APPROVE=true (default) the document is sent to POHODA immediately.",
    { id: z.number().int().describe("Proposal id"), note: z.string().optional().describe("Approval note") },
    async ({ id, note }) => {
      try {
        const proposal = await ctx.outbox.approve(id, ctx.principal, note);
        return ok(JSON.stringify(summarize(proposal), null, 2));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_proposal_reject",
    "Reject a proposal with a reason. HUMAN ONLY. Rejected proposals stay in the log; a corrected write is a new proposal.",
    { id: z.number().int().describe("Proposal id"), reason: z.string().min(1).describe("Why it is rejected") },
    async ({ id, reason }) => {
      try {
        const proposal = await ctx.outbox.reject(id, ctx.principal, reason);
        return ok(JSON.stringify(summarize(proposal), null, 2));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_proposal_send",
    "Send an approved (or failed) proposal to POHODA now. Human or service principal.",
    { id: z.number().int().describe("Proposal id") },
    async ({ id }) => {
      try {
        const { proposal, duplicate } = await ctx.outbox.send(id, ctx.principal);
        return ok(JSON.stringify({ ...summarize(proposal), duplicate }, null, 2));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_proposal_replay",
    "Re-send a sent/refused/failed proposal with the SAME dataPack ids and extId. POHODA's duplicity check guarantees no second document; use it after a timeout or to prove idempotency.",
    { id: z.number().int().describe("Proposal id") },
    async ({ id }) => {
      try {
        const { proposal, duplicate } = await ctx.outbox.replay(id, ctx.principal);
        return ok(JSON.stringify({ ...summarize(proposal), duplicate }, null, 2));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

function summarize(p: { id: number; state: string; tool: string; summary: string; key: string; pohodaId?: number; responseNote?: string; error?: string; attempts: number }) {
  return { id: p.id, state: p.state, tool: p.tool, summary: p.summary, key: p.key, pohodaId: p.pohodaId, responseNote: p.responseNote, error: p.error, attempts: p.attempts };
}
