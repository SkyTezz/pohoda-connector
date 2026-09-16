import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (_name: string, jpath: unknown) => {
    const arrayPaths = [
      "responsePack.responsePackItem",
      "listAddressBook.addressbook",
      "listInvoice.invoice",
      "listOrder.order",
      "listOffer.offer",
      "listEnquiry.enquiry",
      "listContract.contract",
      "listBank.bankItem",
      "listCash.voucher",
      "listIntDoc.intDoc",
      "listStock.stock",
      "listPrijemka.prijemka",
      "listVydejka.vydejka",
      "listProdejka.prodejka",
      "listPrevodka.prevodka",
      "listVyroba.vyroba",
      "listService.service",
      "listAccountancy.accountancy",
      "listBalance.balance",
      "listMovement.movement",
      "listClassificationVAT.classificationVAT",
      "listNumericalSeries.numericalSeries",
      "listCashRegister.cashRegister",
      "listBankAccount.bankAccount",
      "listCentre.centre",
      "listActivity.activity",
      "listPayment.payment",
      "listStore.store",
      "listStorage.storage",
      "listCategory.category",
    ];
    const jp = String(jpath);
    for (const p of arrayPaths) {
      if (jp.endsWith(p)) return true;
    }
    // Document line items: <xxxDetail><xxxItem>. Matching only the last two
    // segments keeps responsePackItem.invoiceResponse.producedDetails a plain
    // object (the old "contains Detail and Item anywhere" rule turned it into
    // arrays and hid the produced id).
    const segments = jp.split(".");
    const last = segments[segments.length - 1] ?? "";
    const parent = segments[segments.length - 2] ?? "";
    return parent.endsWith("Detail") && last.endsWith("Item");
  },
  parseTagValue: true,
  trimValues: true,
});

export interface PohodaResponseItem {
  state: string;
  note?: string;
  id?: string | number;
  data?: unknown;
}

export interface PohodaResponse {
  state: string;
  version: string;
  items: PohodaResponseItem[];
  raw: unknown;
}

export function parseResponse(xml: string): PohodaResponse {
  const doc = parser.parse(xml);
  const pack = doc?.responsePack ?? doc?.["rsp:responsePack"] ?? doc;

  const state = pack?.["@_state"] ?? "unknown";
  const version = pack?.["@_version"] ?? "2.0";

  const rawItems = pack?.responsePackItem ?? pack?.["rsp:responsePackItem"] ?? [];
  const itemArr = Array.isArray(rawItems) ? rawItems : [rawItems];

  const items: PohodaResponseItem[] = itemArr.map((it: Record<string, unknown>) => {
    const itemState = (it["@_state"] as string) ?? "unknown";
    const itemNote = (it["@_note"] as string) ?? undefined;
    const itemId = it["@_id"] as string | undefined;

    const keys = Object.keys(it).filter((k) => !k.startsWith("@_"));
    const data = keys.length === 1 ? it[keys[0]] : keys.length > 0 ? it : undefined;

    return { state: itemState, note: itemNote, id: itemId, data };
  });

  return { state, version, items, raw: doc };
}

export function extractListData(response: PohodaResponse): unknown[] {
  const results: unknown[] = [];
  for (const item of response.items) {
    if (!item.data) continue;
    const d = item.data as Record<string, unknown>;
    for (const val of Object.values(d)) {
      if (Array.isArray(val)) {
        results.push(...val);
      } else if (val && typeof val === "object") {
        const inner = val as Record<string, unknown>;
        for (const v2 of Object.values(inner)) {
          if (Array.isArray(v2)) {
            results.push(...v2);
          }
        }
        if (results.length === 0) results.push(val);
      }
    }
  }
  return results;
}

export interface ImportResult {
  success: boolean;
  message: string;
  producedId?: number;
  producedNumber?: string;
}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function extractImportResult(response: PohodaResponse): ImportResult {
  if (response.items.length === 0) {
    return { success: false, message: "No response items" };
  }
  const item = response.items[0];
  const ok = item.state === "ok";
  const parts: string[] = [item.note ?? item.state];

  if (item.data && typeof item.data === "object") {
    const d = item.data as Record<string, unknown>;
    const detail = first(d.producedDetails ?? d.importDetails) as Record<string, unknown> | undefined;
    if (detail && typeof detail === "object") {
      const id = first(detail.id as number | number[] | undefined);
      const number = first(detail.number as string | number | Array<string | number> | undefined);
      const detailNote = first(detail.note as string | string[] | undefined);
      if (detailNote) parts.push(String(detailNote));
      return {
        success: ok,
        message: parts.join("; "),
        producedId: id != null ? Number(id) : undefined,
        producedNumber: number != null ? String(number) : undefined,
      };
    }
  }

  return { success: ok, message: parts.join("; ") };
}
