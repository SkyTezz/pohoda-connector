import { gunzipSync, inflateSync, inflateRawSync } from "node:zlib";
import * as path from "node:path";
import { decodeFromPohoda, encodeForPohoda } from "./xml/encoding.js";
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

const HTTP = { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, REQUEST_TIMEOUT: 408, SERVICE_UNAVAILABLE: 503 } as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const STATUS_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_TIMEOUT_MS = 2_000;
const RETRY_BACKOFF_BUSY_MS = 3_000;
const MS_PER_SECOND = 1_000;
const CONTENT_TYPE_XML = "text/xml";

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
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.checkDuplicity = config.checkDuplicity ?? false;
    this.authHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf-8").toString("base64")}`;
  }

  async sendXml(xml: string, options: SendOptions = {}): Promise<string> {
    const body = encodeForPohoda(xml);
    const checkDuplicity = options.checkDuplicity ?? this.checkDuplicity;
    const instance = options.instance ?? `${POHODA_APP_NAME}-${Date.now()}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const resp = await fetch(`${this.baseUrl}/xml`, {
          method: "POST",
          headers: {
            "Content-Type": CONTENT_TYPE_XML,
            "STW-Authorization": this.authHeader,
            "Accept-Encoding": "gzip, deflate",
            "STW-Application": POHODA_APP_NAME,
            "STW-Instance": instance,
            ...(checkDuplicity ? { "STW-Check-Duplicity": "true" } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.timeout),
        });

        if (resp.status === HTTP.UNAUTHORIZED) throw new Error("Authentication failed (401). Check POHODA_USERNAME/POHODA_PASSWORD.");
        if (resp.status === HTTP.FORBIDDEN) throw new Error("Access forbidden (403). User lacks permissions in POHODA.");
        if (resp.status === HTTP.NOT_FOUND) throw new Error("Endpoint not found (404). Check POHODA_URL — should point to mServer /xml.");
        if (resp.status === HTTP.REQUEST_TIMEOUT) {
          if (attempt < this.maxRetries) { await sleep(RETRY_BACKOFF_TIMEOUT_MS * (attempt + 1)); continue; }
          throw new Error("Request timeout (408). POHODA took too long to process.");
        }
        if (resp.status === HTTP.SERVICE_UNAVAILABLE) {
          if (attempt < this.maxRetries) { await sleep(RETRY_BACKOFF_BUSY_MS * (attempt + 1)); continue; }
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
        return contentType.toLowerCase().includes("windows-1250") ? decodeFromPohoda(dataBuf) : dataBuf.toString("utf-8");
      } catch (err) {
        lastError = err as Error;
        if ((err as Error).name === "TimeoutError" && attempt < this.maxRetries) {
          await sleep(RETRY_BACKOFF_TIMEOUT_MS * (attempt + 1));
          continue;
        }
        if ((err as Error).name === "TimeoutError") {
          throw new Error(`POHODA mServer did not respond within ${this.timeout / MS_PER_SECOND}s.`);
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Request failed after retries.");
  }

  async getStatus(): Promise<string> {
    return this.getDecoded(`${this.baseUrl}/status`, STATUS_TIMEOUT_MS, "Status check failed");
  }

  async getCompanyInfo(): Promise<string> {
    return this.getDecoded(`${this.baseUrl}/status?companyDetail`, STATUS_TIMEOUT_MS, "Company info failed");
  }

  private async getDecoded(url: string, timeoutMs: number, failure: string): Promise<string> {
    const resp = await fetch(url, { method: "GET", headers: { "STW-Authorization": this.authHeader }, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) throw new Error(`${failure}: HTTP ${resp.status}`);
    return decodeFromPohoda(Buffer.from(await resp.arrayBuffer()));
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const normalized = path.posix.normalize(filePath).replace(/^\/+/, "");
    if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
      throw new Error("Path traversal attempt blocked.");
    }
    const resp = await fetch(`${this.baseUrl}/documents/${encodeURI(normalized)}`, {
      method: "GET",
      headers: { "STW-Authorization": this.authHeader },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`File download failed: HTTP ${resp.status} for ${normalized}`);
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
