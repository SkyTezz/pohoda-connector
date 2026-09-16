import type { ConnectorConfig } from "./config.js";

/**
 * Who is calling.
 *
 * `agent`   — an AI agent or automation: may read and propose, never approve.
 * `human`   — an operator session forwarded by the calling application: may approve.
 * `service` — a trusted backend worker: may send approved proposals, never approve.
 *
 * The rule "no approval without a human" is enforced here in code, not by
 * convention, and the only relaxation is the sandbox accounting unit.
 */
export type Role = "agent" | "human" | "service";

export interface Principal {
  name: string;
  role: Role;
}

export class ForbiddenError extends Error {
  readonly code = "forbidden";
}

export function principalFromBearer(tokens: Record<string, Principal>, authorization: string | undefined): Principal {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) throw new ForbiddenError("missing bearer token");
  const principal = tokens[match[1]];
  if (!principal) throw new ForbiddenError("unknown token");
  return principal;
}

export function canApprove(principal: Principal, config: Pick<ConnectorConfig, "sandbox">): boolean {
  return principal.role === "human" || config.sandbox;
}

export function canSend(principal: Principal, config: Pick<ConnectorConfig, "sandbox">): boolean {
  return principal.role === "human" || principal.role === "service" || config.sandbox;
}

export function assertCanApprove(principal: Principal, config: Pick<ConnectorConfig, "sandbox">): void {
  if (!canApprove(principal, config)) {
    throw new ForbiddenError(
      `approval requires a human principal (caller "${principal.name}" has role "${principal.role}")`,
    );
  }
}

export function assertCanSend(principal: Principal, config: Pick<ConnectorConfig, "sandbox">): void {
  if (!canSend(principal, config)) {
    throw new ForbiddenError(`sending requires a human or service principal (caller "${principal.name}" is "${principal.role}")`);
  }
}
