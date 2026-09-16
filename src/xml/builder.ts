import { create } from "xmlbuilder2";

type XMLBuilder = ReturnType<typeof create>;
import { NS, POHODA_VERSION, POHODA_APP_NAME } from "./namespaces.js";

let requestCounter = 0;

/**
 * Export (read) requests get a process-local counter id: they change nothing
 * in POHODA, so duplicity does not apply. Imports (writes) MUST pass explicit
 * ids from `core/identity.ts`; the counter is never used for them.
 */
function nextExportId(prefix: string): string {
  return `${prefix}_${process.pid}_${++requestCounter}`;
}

export interface DataPackOptions {
  ico: string;
  note?: string;
  /** dataPack@id; required for imports, optional for exports. */
  id?: string;
  /** Accounting period switch for the whole pack (POHODA `period` attribute). */
  period?: string;
}

export interface ImportIds {
  datapackId: string;
  itemId: string;
}

/** Every POHODA namespace declared once on the root, so child elements carry no inline xmlns. */
const ROOT_NAMESPACES: Record<string, string> = Object.fromEntries(
  Object.entries(NS)
    .filter(([prefix]) => prefix !== "dat")
    .map(([prefix, uri]) => [`xmlns:${prefix}`, uri]),
);

export function createDataPack(opts: DataPackOptions): XMLBuilder {
  const pack = create({ version: "1.0", encoding: "Windows-1250" })
    .ele(NS.dat, "dat:dataPack", ROOT_NAMESPACES)
    .att("id", opts.id ?? nextExportId("export"))
    .att("ico", opts.ico)
    .att("application", POHODA_APP_NAME)
    .att("version", POHODA_VERSION)
    .att("note", opts.note ?? `${POHODA_APP_NAME} request`);
  if (opts.period) pack.att("period", opts.period);
  return pack;
}

export function addDataPackItem(dataPack: XMLBuilder, id?: string): XMLBuilder {
  return dataPack
    .ele(NS.dat, "dat:dataPackItem")
    .att("id", id ?? nextExportId("item"))
    .att("version", POHODA_VERSION);
}

export function buildExportRequest(
  opts: DataPackOptions,
  listTag: string,
  listNs: string,
  requestTag: string,
  filterContent?: (req: XMLBuilder) => void,
): string {
  const dp = createDataPack(opts);
  const item = addDataPackItem(dp);
  const listReq = item.ele(listNs, listTag).att("version", POHODA_VERSION);
  const req = listReq.ele(listNs, requestTag);
  if (filterContent) filterContent(req);
  return dp.end({ prettyPrint: false });
}

/** Import document with deterministic ids (see core/identity.ts). */
export function buildImportDoc(
  opts: DataPackOptions,
  ids: ImportIds,
  docBuilder: (item: XMLBuilder) => void,
): string {
  const dp = createDataPack({ ...opts, id: ids.datapackId });
  const item = addDataPackItem(dp, ids.itemId);
  docBuilder(item);
  return dp.end({ prettyPrint: false });
}

export { create, type XMLBuilder };
