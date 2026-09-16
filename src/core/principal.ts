import { createHash, timingSafeEqual } from "node:crypto";
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
export const ROLES: readonly Role[] = ["agent", "human", "service"];

export interface Principal {
  name: string;
  role: Role;
}

export class ForbiddenError extends Error {
  readonly code = "forbidden";
}

const TOKEN_HASH_BYTES = 32;
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf-8").digest();
}

/**
 * Bearer tokens are looked up by SHA-256 digest with a constant-time compare
 * over EVERY configured entry, so neither the token bytes nor the position of
 * a match leak through timing. Built from a plain object once, at config time.
 */
export class TokenTable {
  private readonly entries: ReadonlyArray<{ digest: Buffer; principal: Principal }>;

  constructor(tokens: ReadonlyMap<string, Principal>) {
    this.entries = [...tokens.entries()].map(([token, principal]) => ({ digest: hashToken(token), principal: { ...principal } }));
  }

  get size(): number {
    return this.entries.length;
  }

  lookup(token: string): Principal | undefined {
    const digest = hashToken(token);
    // Scan all entries; never break early. timingSafeEqual needs equal lengths (always 32 here).
    return this.entries.reduce<Principal | undefined>(
      (found, entry) => (digest.length === TOKEN_HASH_BYTES && timingSafeEqual(digest, entry.digest) ? entry.principal : found),
      undefined,
    );
  }
}

export function principalFromBearer(tokens: TokenTable, authorization: string | undefined): Principal {
  const match = BEARER_PATTERN.exec(authorization ?? "");
  if (!match) throw new ForbiddenError("missing bearer token");
  const principal = tokens.lookup(match[1]);
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
    throw new ForbiddenError(`approval requires a human principal (caller "${principal.name}" has role "${principal.role}")`);
  }
}

export function assertCanSend(principal: Principal, config: Pick<ConnectorConfig, "sandbox">): void {
  if (!canSend(principal, config)) {
    throw new ForbiddenError(`sending requires a human or service principal (caller "${principal.name}" is "${principal.role}")`);
  }
}
