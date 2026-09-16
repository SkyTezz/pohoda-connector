import { describe, expect, it } from "vitest";
import { deriveKey, packIds, stableStringify } from "../src/core/identity.js";

describe("identity", () => {
  it("stableStringify is order-independent and drops undefined", () => {
    expect(stableStringify({ b: 1, a: [3, { z: 1, y: undefined }] })).toBe(stableStringify({ a: [3, { y: undefined, z: 1 }], b: 1 }));
  });

  it("derives the same key for the same tool call", () => {
    const a = deriveKey("pohoda_create_invoice", { date: "2026-09-16", items: [{ text: "x" }] });
    const b = deriveKey("pohoda_create_invoice", { items: [{ text: "x" }], date: "2026-09-16" });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("different calls get different keys", () => {
    expect(deriveKey("pohoda_create_invoice", { date: "2026-09-16" })).not.toBe(deriveKey("pohoda_create_invoice", { date: "2026-09-17" }));
    expect(deriveKey("pohoda_create_invoice", { date: "2026-09-16" })).not.toBe(deriveKey("pohoda_create_bank", { date: "2026-09-16" }));
  });

  it("validates explicit keys", () => {
    expect(deriveKey("t", {}, "order-invoice:2026000001:r1")).toBe("order-invoice:2026000001:r1");
    expect(() => deriveKey("t", {}, "bad key with spaces")).toThrow(/idempotencyKey/);
    expect(() => deriveKey("t", {}, "x".repeat(49))).toThrow(/idempotencyKey/);
  });

  it("packIds stays within string64", () => {
    const ids = packIds("TEST", "order-invoice:2026000001:r1");
    expect(ids).toEqual({ datapackId: "TEST-order-invoice:2026000001:r1", itemId: "order-invoice:2026000001:r1", extIds: "order-invoice:2026000001:r1" });
    expect(() => packIds("P".repeat(40), "k".repeat(48))).toThrow(/exceeds 64/);
  });
});
