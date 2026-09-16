import { z } from "zod";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { buildExportRequest } from "../xml/builder.js";
import { NS } from "../xml/namespaces.js";
import { parseResponse, extractListData } from "../xml/parser.js";
import { err, jsonResult } from "../core/types.js";

const SETTINGS_TYPES: Record<string, { listTag: string; listNs: string; requestTag: string }> = {
  numericalSeries: { listTag: "lst:listNumericalSeriesRequest", listNs: NS.lst, requestTag: "lst:requestNumericalSeries" },
  cashRegister: { listTag: "lst:listCashRegisterRequest", listNs: NS.lst, requestTag: "lst:requestCashRegister" },
  bankAccount: { listTag: "lst:listBankAccountRequest", listNs: NS.lst, requestTag: "lst:requestBankAccount" },
  centre: { listTag: "lst:listCentreRequest", listNs: NS.lCen, requestTag: "lst:requestCentre" },
  activity: { listTag: "lst:listActivityRequest", listNs: NS.lAcv, requestTag: "lst:requestActivity" },
  payment: { listTag: "lst:listPaymentRequest", listNs: NS.lst, requestTag: "lst:requestPayment" },
  store: { listTag: "lst:listStoreRequest", listNs: NS.lst, requestTag: "lst:requestStore" },
  storage: { listTag: "lst:listStorageRequest", listNs: NS.lst, requestTag: "lst:requestStorage" },
  category: { listTag: "lst:listCategoryRequest", listNs: NS.lst, requestTag: "lst:requestCategory" },
  accountingUnit: { listTag: "lst:listAccountingUnitRequest", listNs: NS.lst, requestTag: "lst:requestAccountingUnit" },
};

const settingsTypeEnum = Object.keys(SETTINGS_TYPES) as [string, ...string[]];

export function registerSettingsTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_list_settings",
    "Export settings/lists from POHODA — the codes you need for mappings: numericalSeries, cashRegister, bankAccount, centre, activity, payment, store, storage, category, accountingUnit",
    { settingsType: z.enum(settingsTypeEnum).describe("Type of settings to export") },
    async (params) => {
      try {
        const cfg = SETTINGS_TYPES[params.settingsType];
        if (!cfg) return err(`Unknown settings type: ${params.settingsType}`);
        const xml = buildExportRequest({ ico: ctx.client.ico }, cfg.listTag, cfg.listNs, cfg.requestTag);
        const data = extractListData(parseResponse(await ctx.client.sendXml(xml)));
        return jsonResult(`Settings: ${params.settingsType}`, data, data.length);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}
