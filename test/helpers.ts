import type { ConnectorConfig } from "../src/core/config.js";
import type { Principal } from "../src/core/principal.js";
import type { SendOptions } from "../src/client.js";
import { OutboxService } from "../src/outbox/service.js";
import { SqliteOutboxStore } from "../src/outbox/sqlite_store.js";
import { createRegistry, type ServerDeps } from "../src/server.js";

export const AGENT: Principal = { name: "agent-test", role: "agent" };
export const HUMAN: Principal = { name: "operator", role: "human" };
export const SERVICE: Principal = { name: "worker", role: "service" };

export function testConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    pohoda: { url: "http://pohoda.test:444", username: "u", password: "p", ico: "12345678", timeout: 1000, maxRetries: 0 },
    writeMode: "approval",
    allowDelete: false,
    autoSendOnApprove: false,
    sandbox: false,
    extSystem: "TEST",
    store: { kind: "sqlite", sqlitePath: ":memory:" },
    sql: undefined,
    transport: "stdio",
    http: { host: "127.0.0.1", port: 0, tokens: {} },
    stdioPrincipal: AGENT,
    ...overrides,
  };
}

/** Records every XML sent and answers with a scripted responsePack. */
export class FakeClient {
  readonly ico: string;
  readonly sent: Array<{ xml: string; options?: SendOptions }> = [];
  queue: Array<string | Error> = [];

  constructor(ico = "12345678") {
    this.ico = ico;
  }

  async sendXml(xml: string, options?: SendOptions): Promise<string> {
    this.sent.push({ xml, options });
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? okResponse("1");
  }

  async getStatus(): Promise<string> {
    return "<response><status>idle</status></response>";
  }

  async getCompanyInfo(): Promise<string> {
    return "<response><company><name>Test</name></company></response>";
  }

  async downloadFile(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
}

export function okResponse(itemId: string, producedId = 4711, number = "26FV00001"): string {
  return `<?xml version="1.0" encoding="Windows-1250"?>
<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:rdc="http://www.stormware.cz/schema/version_2/documentresponse.xsd" version="2.0" id="pack" state="ok">
  <rsp:responsePackItem version="2.0" id="${itemId}" state="ok">
    <rdc:invoiceResponse version="2.0" state="ok"><rdc:producedDetails><rdc:id>${producedId}</rdc:id><rdc:number>${number}</rdc:number></rdc:producedDetails></rdc:invoiceResponse>
  </rsp:responsePackItem>
</rsp:responsePack>`;
}

export function errorResponse(itemId: string, note: string): string {
  return `<?xml version="1.0" encoding="Windows-1250"?>
<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" id="pack" state="error">
  <rsp:responsePackItem version="2.0" id="${itemId}" state="error" note="${note}"/>
</rsp:responsePack>`;
}

export async function harness(overrides: Partial<ConnectorConfig> = {}) {
  const config = testConfig(overrides);
  const client = new FakeClient(config.pohoda.ico);
  const store = new SqliteOutboxStore(":memory:");
  await store.init();
  const outbox = new OutboxService(store, config, client);
  const deps = { config, client, outbox } as unknown as ServerDeps;
  const registryFor = (principal: Principal) => createRegistry(deps, principal, false).registry;
  return { config, client, store, outbox, deps, registryFor };
}

export function parseToolJson(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  const text = result.content.map((c) => c.text).join("\n");
  return JSON.parse(text.slice(text.indexOf("{")));
}
