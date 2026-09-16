import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { TokenTable, principalFromBearer, ForbiddenError, type Principal } from "../src/core/principal.js";

function rawStatus(base: string, path: string, host: string): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, method: "GET", headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}
import { encodeForPohoda, unencodableCharacters, EncodingError } from "../src/xml/encoding.js";
import { startHttpServer } from "../src/http/server.js";
import { harness } from "./helpers.js";

describe("security hardening", () => {
  describe("TokenTable & principalFromBearer", () => {
    const validToken = "secret-token-secret-token-1234";
    const tokens = new TokenTable(
      new Map<string, Principal>([
        [validToken, { name: "test-human", role: "human" }],
      ]),
    );

    it("accepts valid token in constant-time lookup", () => {
      const p = principalFromBearer(tokens, `Bearer ${validToken}`);
      expect(p).toEqual({ name: "test-human", role: "human" });
    });

    it("rejects unknown tokens with ForbiddenError", () => {
      expect(() => principalFromBearer(tokens, "Bearer wrong-token-wrong-token-1234")).toThrow(ForbiddenError);
      expect(() => principalFromBearer(tokens, undefined)).toThrow(ForbiddenError);
      expect(() => principalFromBearer(tokens, "")).toThrow(ForbiddenError);
    });

    it("is immune to prototype pollution (toString, __proto__, valueOf)", () => {
      expect(() => principalFromBearer(tokens, "Bearer toString")).toThrow(ForbiddenError);
      expect(() => principalFromBearer(tokens, "Bearer __proto__")).toThrow(ForbiddenError);
      expect(() => principalFromBearer(tokens, "Bearer valueOf")).toThrow(ForbiddenError);
      expect(() => principalFromBearer(tokens, "Bearer constructor")).toThrow(ForbiddenError);
    });
  });

  describe("Windows-1250 encoding guard", () => {
    it("permits valid Czech and standard characters", () => {
      const text = "Příliš žluťoučký kůň úpěl ďábelské ódy 12345 CZK";
      expect(unencodableCharacters(text)).toEqual([]);
      const encoded = encodeForPohoda(text);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it("catches characters outside Windows-1250 and throws EncodingError", () => {
      const badText = "Invoice with emoji 🪙 and special char ₿ and Chinese 你";
      const badChars = unencodableCharacters(badText);
      expect(badChars).toContain("🪙");
      expect(badChars).toContain("₿");
      expect(badChars).toContain("你");
      expect(() => encodeForPohoda(badText)).toThrow(EncodingError);
    });
  });

  describe("HTTP Host-header allow-list", () => {
    it("blocks requests when Host header does not match allowedHosts", async () => {
      const h = await harness({
        transport: "http",
        http: {
          host: "127.0.0.1",
          port: 0,
          tokens: new TokenTable(new Map()),
          allowedHosts: ["allowed.internal.local"],
          maxSessions: 100,
          sessionIdleMs: 60_000,
        },
      });
      const server = await startHttpServer(h.deps);
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/v1/healthz`, {
          headers: { Host: "evil.attacker.com" },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("host_not_allowed");
      } finally {
        await server.close();
      }
    });

    it("allows requests matching allowedHosts", async () => {
      const h = await harness({
        transport: "http",
        http: {
          host: "127.0.0.1",
          port: 0,
          tokens: new TokenTable(new Map()),
          allowedHosts: ["allowed.internal.local"],
          maxSessions: 100,
          sessionIdleMs: 60_000,
        },
      });
      const server = await startHttpServer(h.deps);
      try {
        // fetch() silently drops a caller-set Host header (forbidden header name); a raw request is needed to send it.
        expect(await rawStatus(`http://127.0.0.1:${server.port}`, "/v1/healthz", "allowed.internal.local")).toBe(200);
        expect(await rawStatus(`http://127.0.0.1:${server.port}`, "/v1/healthz", `allowed.internal.local:${server.port}`)).toBe(200);
      } finally {
        await server.close();
      }
    });
  });
});
