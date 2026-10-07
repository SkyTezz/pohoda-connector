import { AsyncLocalStorage } from "node:async_hooks";
import { PohodaClient, type MServer } from "../client.js";

/**
 * Accounting units this connector serves.
 *
 * POHODA runs one mServer configuration per accounting unit (its own port), so
 * a connector that books for several companies talks to several mServers. A
 * unit can also be known without an mServer: documents for it are proposed and
 * approved as usual and wait in `approved` until its mServer is configured.
 *
 * Tool handlers do not pick a unit themselves. The registry reads the
 * `accountingUnit` argument, opens a scope for the call (`run`), and the
 * `routed` client the tools hold answers for the unit of that scope.
 */
export interface MServerConnection {
  url: string;
  username: string;
  password: string;
  timeout: number;
  maxRetries: number;
}

export interface UnitConfig {
  /** IČO: the identity of the accounting unit, also `dataPack@ico`. */
  ico: string;
  /** Display only; never used to decide anything. */
  name?: string;
  mserver?: MServerConnection;
}

export class UnitError extends Error {}

export type ClientFactory = (unit: UnitConfig & { mserver: MServerConnection }) => MServer;

const realClient: ClientFactory = (unit) => new PohodaClient({ ...unit.mserver, ico: unit.ico, checkDuplicity: true });

export class Units {
  private readonly byIco: Map<string, UnitConfig>;
  private readonly clients = new Map<string, MServer>();
  private readonly scope = new AsyncLocalStorage<UnitConfig>();

  /**
   * What tools hold as `ctx.client`. `ico` is the unit of the current call, so
   * a document can be built (and proposed) for a unit whose mServer is not
   * there yet; everything that needs the wire goes to that unit's mServer.
   */
  readonly routed: MServer;

  constructor(
    units: readonly UnitConfig[],
    private readonly makeClient: ClientFactory = realClient,
  ) {
    this.byIco = new Map(units.map((u) => [u.ico, u]));
    if (this.byIco.size !== units.length) throw new Error("accounting units: an IČO is configured twice");
    const current = (): UnitConfig => this.current();
    const wire = (): MServer => this.client(current().ico);
    this.routed = {
      get ico() {
        return current().ico;
      },
      sendXml: (xml, options) => wire().sendXml(xml, options),
      getStatus: () => wire().getStatus(),
      getCompanyInfo: () => wire().getCompanyInfo(),
      downloadFile: (filePath) => wire().downloadFile(filePath),
    };
  }

  get size(): number {
    return this.byIco.size;
  }

  list(): Array<{ ico: string; name: string | null; mserver: boolean }> {
    return [...this.byIco.values()].map((u) => ({ ico: u.ico, name: u.name ?? null, mserver: u.mserver !== undefined }));
  }

  /** The unit a call is for. Without an IČO only a connector serving exactly one unit has an answer. */
  resolve(ico: string | undefined): UnitConfig {
    if (ico == null || ico === "") {
      if (this.byIco.size === 1) return [...this.byIco.values()][0];
      throw new UnitError(`accountingUnit is required: this connector serves ${this.describe()}`);
    }
    const unit = this.byIco.get(ico);
    if (!unit) throw new UnitError(`unknown accounting unit "${ico}": this connector serves ${this.describe()}`);
    return unit;
  }

  private describe(): string {
    return this.byIco.size === 0 ? "no accounting unit" : [...this.byIco.keys()].join(", ");
  }

  hasMServer(ico: string | undefined): boolean {
    return this.resolve(ico).mserver !== undefined;
  }

  /** The mServer of one unit; a unit without one says so instead of sending anywhere. */
  client(ico: string | undefined): MServer {
    const unit = this.resolve(ico);
    if (!unit.mserver) throw new UnitError(`mServer of accounting unit ${unit.ico} is not configured on this connector; nothing can be sent or read through it yet`);
    let client = this.clients.get(unit.ico);
    if (!client) {
      client = this.makeClient({ ...unit, mserver: unit.mserver });
      this.clients.set(unit.ico, client);
    }
    return client;
  }

  /** Run one tool call for one unit. */
  run<T>(ico: string | undefined, fn: () => T): T {
    return this.scope.run(this.resolve(ico), fn);
  }

  private current(): UnitConfig {
    const unit = this.scope.getStore();
    if (!unit) throw new UnitError("no accounting unit in scope: mServer tools must be called through the registry");
    return unit;
  }
}
