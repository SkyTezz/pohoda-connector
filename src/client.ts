import { gunzipSync, inflateSync, inflateRawSync } from "node:zlib";
import * as path from "node:path";
import iconv from "iconv-lite";
import { POHODA_APP_NAME } from "./xml/namespaces.js";

export interface PohodaClientConfig {
  url: string;
  username: string;
  password: string;
  ico: string;
  timeout?: number;
  maxRetries?: number;
  /** Default for requests that do not say; writes through the outbox always force it on. */
  checkDuplicity?: boolean;
}

export interface SendOptions {
  /** Ask mServer to reject a dataPack whose ids were already imported. */
  checkDuplicity?: boolean;
  /** STW-Instance header: correlates this request in POHODA's own log. */
  instance?: string;
}

/** Thin HTTP client for POHODA mServer: Windows-1250 both ways, Basic auth, serial processing on the server side. */
export class PohodaClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  readonly ico: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly checkDuplicity: boolean;

  constructor(config: PohodaClientConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.ico = config.ico;
    this.timeout = config.timeout ?? 120_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.checkDuplicity = config.checkDuplicity ?? false;

    const creds = `${config.username}:${config.password}`;
    this.authHeader = `Basic ${Buffer.from(creds, "utf-8").toString("base64")}`;
  }

  async sendXml(xml: string, options: SendOptions = {}): Promise<string> {
    const body = new Uint8Array(iconv.encode(xml, "win1250"));
    const checkDuplicity = options.checkDuplicity ?? this.checkDuplicity;
    const instance = options.instance ?? `${POHODA_APP_NAME}-${Date.now()}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const resp = await fetch(`${this.baseUrl}/xml`, {
          method: "POST",
          headers: {
            "Content-Type": "text/xml",
            "STW-Authorization": this.authHeader,
            "Accept-Encoding": "gzip, deflate",
            "STW-Application": POHODA_APP_NAME,
            "STW-Instance": instance,
            ...(checkDuplicity ? { "STW-Check-Duplicity": "true" } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.timeout),
        });

        if (resp.status === 401) throw new Error("Authentication failed (401). Check POHODA_USERNAME/POHODA_PASSWORD.");
        if (resp.status === 403) throw new Error("Access forbidden (403). User lacks permissions in POHODA.");
        if (resp.status === 404) throw new Error("Endpoint not found (404). Check POHODA_URL — should point to mServer /xml.");
        if (resp.status === 408) {
          if (attempt < this.maxRetries) { await sleep(2000 * (attempt + 1)); continue; }
          throw new Error("Request timeout (408). POHODA took too long to process.");
        }
        if (resp.status === 503) {
          if (attempt < this.maxRetries) { await sleep(3000 * (attempt + 1)); continue; }
          throw new Error("Service unavailable (503). POHODA mServer may be busy.");
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

        const rawBuf = Buffer.from(await resp.arrayBuffer());
        const encoding = resp.headers.get("content-encoding");
        const dataBuf =
          encoding === "gzip" ? gunzipSync(rawBuf) :
          encoding === "deflate" ? safeInflate(rawBuf) :
          rawBuf;

        const contentType = resp.headers.get("content-type") ?? "";
        if (contentType.toLowerCase().includes("windows-1250")) {
          return iconv.decode(dataBuf, "win1250");
        }
        return dataBuf.toString("utf-8");
      } catch (err) {
        lastError = err as Error;
        if ((err as Error).name === "TimeoutError" && attempt < this.maxRetries) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        if ((err as Error).name === "TimeoutError") {
          throw new Error(`POHODA mServer did not respond within ${this.timeout / 1000}s.`);
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Request failed after retries.");
  }

  async getStatus(): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/status`, {
      method: "GET",
      headers: { "STW-Authorization": this.authHeader },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Status check failed: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return iconv.decode(buf, "win1250");
  }

  async getCompanyInfo(): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/status?companyDetail`, {
      method: "GET",
      headers: { "STW-Authorization": this.authHeader },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Company info failed: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return iconv.decode(buf, "win1250");
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const normalized = path.posix.normalize(filePath).replace(/^\/+/, "");
    if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
      throw new Error("Path traversal attempt blocked.");
    }
    const safePath = normalized;
    const resp = await fetch(`${this.baseUrl}/documents/${encodeURI(safePath)}`, {
      method: "GET",
      headers: { "STW-Authorization": this.authHeader },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`File download failed: HTTP ${resp.status} for ${safePath}`);
    return Buffer.from(await resp.arrayBuffer());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeInflate(buf: Buffer): Buffer {
  try {
    return inflateSync(buf);
  } catch (err) {
    // Some servers send raw (headerless) deflate streams; retry without the
    // zlib wrapper. Other error kinds are rethrown rather than masked.
    if ((err as NodeJS.ErrnoException).code !== "Z_DATA_ERROR") throw err;
    return inflateRawSync(buf);
  }
}
