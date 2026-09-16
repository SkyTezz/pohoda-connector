import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { registerWriteTool } from "../core/write_tool.js";
import { buildExportRequest, buildImportDoc, type XMLBuilder } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";
import { applyFilter, type ListFilterParams } from "../core/filters.js";
import { addText, refSchema, addRef } from "../xml/common.js";

const addressFields = {
  company: z.string().max(96).optional().describe("Company name"),
  division: z.string().max(32).optional(),
  name: z.string().max(32).optional().describe("Contact person or private person name"),
  street: z.string().max(64).optional(),
  city: z.string().max(45).optional(),
  zip: z.string().max(15).optional(),
  ico: z.string().max(15).optional(),
  dic: z.string().max(18).optional(),
  country: z.string().max(19).optional().describe("Country IDS, e.g. CZ"),
  email: z.string().max(98).optional(),
  phone: z.string().max(40).optional(),
  mobil: z.string().max(24).optional(),
  web: z.string().max(32).optional(),
  adGroup: z.string().max(19).optional().describe("Address group IDS"),
  number: z.string().max(32).optional().describe("Customer/supplier number"),
  centre: refSchema.optional(),
  activity: refSchema.optional(),
  note: z.string().optional(),
  intNote: z.string().optional(),
};

type AddressParams = z.objectOutputType<typeof addressFields, z.ZodTypeAny>;

function buildAddressHeader(adb: XMLBuilder, p: AddressParams, extIds: string | undefined, exSystem: string): void {
  const header = adb.ele(NS.adb, "adb:addressbookHeader");
  if (extIds) {
    const ext = header.ele(NS.adb, "adb:extId");
    ext.ele(NS.typ, "typ:ids").txt(extIds);
    ext.ele(NS.typ, "typ:exSystemName").txt(exSystem);
  }
  const identity = header.ele(NS.adb, "adb:identity");
  const addr = identity.ele(NS.typ, "typ:address");
  addText(addr, NS.typ, "typ:company", p.company);
  addText(addr, NS.typ, "typ:division", p.division);
  addText(addr, NS.typ, "typ:name", p.name);
  addText(addr, NS.typ, "typ:city", p.city);
  addText(addr, NS.typ, "typ:street", p.street);
  addText(addr, NS.typ, "typ:zip", p.zip);
  addText(addr, NS.typ, "typ:ico", p.ico);
  addText(addr, NS.typ, "typ:dic", p.dic);
  if (p.country) addr.ele(NS.typ, "typ:country").ele(NS.typ, "typ:ids").txt(p.country);
  addText(header, NS.adb, "adb:phone", p.phone);
  addText(header, NS.adb, "adb:mobil", p.mobil);
  addText(header, NS.adb, "adb:email", p.email);
  addText(header, NS.adb, "adb:web", p.web);
  if (p.adGroup) header.ele(NS.adb, "adb:adGroup").ele(NS.typ, "typ:ids").txt(p.adGroup);
  addText(header, NS.adb, "adb:number", p.number);
  addText(header, NS.adb, "adb:note", p.note);
  addText(header, NS.adb, "adb:intNote", p.intNote);
  if (p.centre) addRef(header, NS.adb, "adb:centre", p.centre);
  if (p.activity) addRef(header, NS.adb, "adb:activity", p.activity);
}

const targetSchema = z
  .object({
    id: z.number().int().optional().describe("POHODA address id"),
    extId: z.string().max(64).optional().describe("extId (ids) the address was created with"),
    ico: z.string().max(15).optional().describe("IČO (must match exactly one address)"),
  })
  .refine((t) => t.id != null || t.extId != null || t.ico != null, { message: "give id, extId or ico" });

function withoutTarget<T extends { target: unknown }>(params: T): Omit<T, "target"> {
  const { target: _target, ...rest } = params;
  return rest;
}

function addTargetFilter(actionEl: XMLBuilder, target: z.infer<typeof targetSchema>, exSystem: string): void {
  const filter = actionEl.ele(NS.ftr, "ftr:filter");
  if (target.id != null) filter.ele(NS.ftr, "ftr:id").txt(String(target.id));
  else if (target.extId != null) {
    const ext = filter.ele(NS.ftr, "ftr:extId");
    ext.ele(NS.typ, "typ:ids").txt(target.extId);
    ext.ele(NS.typ, "typ:exSystemName").txt(exSystem);
  } else if (target.ico != null) filter.ele(NS.ftr, "ftr:ico").txt(target.ico);
}

export function registerAddressTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_addresses",
    "List addresses from POHODA addressbook. Supports filtering by id, company name, IČO, last changes date, or code. Returns JSON array of matching address records.",
    {
      id: z.number().optional().describe("Filter by address ID"),
      companyName: z.string().optional().describe("Filter by company name"),
      ico: z.string().optional().describe("Filter by IČO (company ID number)"),
      lastChanges: z.string().optional().describe("Filter by last changes date (DD.MM.YYYY or YYYY-MM-DD)"),
      code: z.string().optional().describe("Filter by address code"),
    },
    async (params) => {
      try {
        const filterParams: ListFilterParams = { id: params.id, companyName: params.companyName, ico: params.ico, lastChanges: params.lastChanges, code: params.code };
        const xml = buildExportRequest({ ico: ctx.client.ico }, "lst:listAddressBookRequest", NS.lAdb, "lst:requestAddressBook", (req) => applyFilter(req, filterParams));
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult("Addresses", data, Array.isArray(data) ? data.length : 0);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  registerWriteTool(host, ctx, {
    name: "pohoda_create_address",
    description: "Create an address/contact in the POHODA addressbook. The extId is set from the idempotency key so documents can bind to it later (partner.extId).",
    kind: "create",
    agenda: "addressbook",
    schema: addressFields,
    summary: (p) => `address ${p.company ?? p.name ?? p.ico ?? ""}`.trim(),
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: `address ${p.company ?? p.name ?? ""}`.trim() }, ids, (item) => {
        const adb = item.ele(NS.adb, "adb:addressbook").att("version", "2.0");
        buildAddressHeader(adb, p, ids.extIds, c.config.extSystem);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_update_address",
    description: "Update an existing address in the POHODA addressbook, located by id, extId or IČO. Only the given fields change.",
    kind: "update",
    agenda: "addressbook",
    schema: { target: targetSchema.describe("Which address to update"), ...addressFields },
    summary: (p) => `update address ${p.target.extId ?? p.target.ico ?? p.target.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: "update address" }, ids, (item) => {
        const adb = item.ele(NS.adb, "adb:addressbook").att("version", "2.0");
        addTargetFilter(adb.ele(NS.adb, "adb:actionType").ele(NS.adb, "adb:update"), p.target, c.config.extSystem);
        buildAddressHeader(adb, withoutTarget(p), undefined, c.config.extSystem);
      }),
  });

  registerWriteTool(host, ctx, {
    name: "pohoda_delete_address",
    description: "Delete an address from the POHODA addressbook. Disabled unless CONNECTOR_ALLOW_DELETE=true.",
    kind: "delete",
    agenda: "addressbook",
    schema: { target: targetSchema },
    summary: (p) => `delete address ${p.target.extId ?? p.target.ico ?? p.target.id}`,
    build: (p, ids, c) =>
      buildImportDoc({ ico: c.client.ico, note: "delete address" }, ids, (item) => {
        const adb = item.ele(NS.adb, "adb:addressbook").att("version", "2.0");
        addTargetFilter(adb.ele(NS.adb, "adb:actionType").ele(NS.adb, "adb:delete"), p.target, c.config.extSystem);
      }),
  });
}
