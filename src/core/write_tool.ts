import { z, type ZodRawShape } from "zod";
import type { ConnectorContext } from "./context.js";
import { deriveKey, packIds, sha256Hex, type PackIds } from "./identity.js";
import type { ToolHost } from "./registry.js";
import { ok, err, type ToolResult } from "./types.js";
import { parseResponse, extractImportResult } from "../xml/parser.js";
import { EncodingError, unencodableCharacters } from "../xml/encoding.js";
import type { ProposalKind } from "../outbox/types.js";

/**
 * Every tool that would change POHODA is declared through this helper.
 *
 * The tool builds its XML with deterministic ids; the helper decides what
 * happens next: in `direct` mode the XML goes to mServer, in `approval` mode
 * (default) it becomes a proposal that a human approves. Tools never call
 * `client.sendXml` for writes themselves, so there is exactly one gate.
 */
export interface WriteToolSpec<Shape extends ZodRawShape> {
  name: string;
  description: string;
  schema: Shape;
  kind: ProposalKind;
  agenda: string;
  summary: (params: z.objectOutputType<Shape, z.ZodTypeAny>) => string;
  build: (params: z.objectOutputType<Shape, z.ZodTypeAny>, ids: PackIds, ctx: ConnectorContext) => string;
}

const gateFields = {
  idempotencyKey: z
    .string()
    .optional()
    .describe(
      "Stable identity of this write (1-48 chars, [A-Za-z0-9._:-]). Becomes dataPackItem@id and extId; the same key never creates a second document. Derived from the arguments when omitted.",
    ),
  reason: z.string().optional().describe("Why this write is proposed — shown to the approver."),
};

const XML_PREVIEW_CHARS = 4000;

export function registerWriteTool<Shape extends ZodRawShape>(host: ToolHost, ctx: ConnectorContext, spec: WriteToolSpec<Shape>): void {
  const schema = { ...spec.schema, ...gateFields };
  host.tool(spec.name, describe(spec.description, ctx), schema, async (raw) => {
    try {
      const { idempotencyKey, reason, ...params } = raw as z.objectOutputType<Shape, z.ZodTypeAny> & {
        idempotencyKey?: string;
        reason?: string;
      };
      if (spec.kind === "delete" && !ctx.config.allowDelete) {
        return err(`${spec.name} is disabled: POHODA documents are reversed with storno/corrective documents, never deleted (CONNECTOR_ALLOW_DELETE=false).`);
      }
      const key = deriveKey(spec.name, params, idempotencyKey);
      const ids = packIds(ctx.config.extSystem, key);
      const xml = spec.build(params as z.objectOutputType<Shape, z.ZodTypeAny>, ids, ctx);
      // mServer speaks Windows-1250; refuse now rather than mangle silently at send time.
      const unencodable = unencodableCharacters(xml);
      if (unencodable.length > 0) throw new EncodingError(unencodable);
      const summary = spec.summary(params as z.objectOutputType<Shape, z.ZodTypeAny>);

      if (ctx.config.writeMode === "direct") return sendDirect(ctx, xml, ids, summary);

      const { proposal, created } = await ctx.outbox.propose({
        key,
        tool: spec.name,
        kind: spec.kind,
        agenda: spec.agenda,
        summary,
        args: params,
        xml,
        xmlHash: sha256Hex(xml),
        datapackId: ids.datapackId,
        itemId: ids.itemId,
        proposedBy: ctx.principal.name,
        reason,
      });
      return ok(
        JSON.stringify(
          {
            outcome: created ? "proposed" : "already_proposed",
            proposalId: proposal.id,
            key: proposal.key,
            state: proposal.state,
            tool: proposal.tool,
            summary: proposal.summary,
            datapackId: proposal.datapackId,
            next: proposal.state === "proposed" ? "a human approves with pohoda_proposal_approve" : `already ${proposal.state}`,
            xmlPreview: proposal.xml.length > XML_PREVIEW_CHARS ? `${proposal.xml.slice(0, XML_PREVIEW_CHARS)}…` : proposal.xml,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      return err((e as Error).message);
    }
  });
}

function describe(base: string, ctx: ConnectorContext): string {
  return ctx.config.writeMode === "approval"
    ? `${base} Write mode: APPROVAL — this call creates a proposal (returns proposalId); nothing reaches POHODA until a human approves it.`
    : `${base} Write mode: DIRECT — this call is sent to POHODA immediately.`;
}

async function sendDirect(ctx: ConnectorContext, xml: string, ids: PackIds, summary: string): Promise<ToolResult> {
  const response = await ctx.client.sendXml(xml, { checkDuplicity: true, instance: ids.datapackId });
  const result = extractImportResult(parseResponse(response));
  return result.success
    ? ok(`${summary}: done.${result.producedId != null ? ` ID: ${result.producedId}.` : ""} ${result.message} (key ${ids.itemId})`)
    : err(`${summary}: POHODA refused — ${result.message} (key ${ids.itemId})`);
}
