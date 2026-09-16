import { createHash } from "node:crypto";

/**
 * Deterministic identity for every write.
 *
 * POHODA checks duplicates on `dataPack@id` + `dataPackItem@id` and can look a
 * document up by `extId`. If those ids were random, a retry after a timeout
 * could create the same invoice twice and nothing could ever prove it. So the
 * ids are a pure function of (tool, arguments) unless the caller supplies its
 * own idempotency key — replaying the same proposal always carries the same ids.
 */
export interface PackIds {
  /** dataPack@id — string64 in the schema. */
  datapackId: string;
  /** dataPackItem@id — string64. */
  itemId: string;
  /** extId/ids — string64; the document's identity in the external system. */
  extIds: string;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/;
const DERIVED_KEY_LENGTH = 32;
const STRING64 = 64;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Idempotency key: caller-supplied (validated) or derived from the tool call. */
export function deriveKey(tool: string, args: unknown, explicit?: string): string {
  if (explicit != null && explicit !== "") {
    if (!isValidKey(explicit)) {
      throw new Error(`idempotencyKey must match ${KEY_PATTERN} (1-48 chars), got "${explicit}"`);
    }
    return explicit;
  }
  return sha256Hex(`${tool}\n${stableStringify(args)}`).slice(0, DERIVED_KEY_LENGTH);
}

export function packIds(prefix: string, key: string): PackIds {
  const datapackId = `${prefix}-${key}`;
  if (datapackId.length > STRING64) {
    throw new Error(`dataPack id "${datapackId}" exceeds ${STRING64} characters; shorten CONNECTOR_EXT_SYSTEM or the key`);
  }
  return { datapackId, itemId: key, extIds: key };
}
