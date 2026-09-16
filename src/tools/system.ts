import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import type { ConnectorContext } from "../core/context.js";
import type { ToolHost } from "../core/registry.js";
import { ok, err } from "../core/types.js";

function parseStatusXml(xml: string): { server?: string; status?: string; processing?: string; message?: string } {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const doc = parser.parse(xml);
  const root = doc?.response ?? doc?.Response ?? doc;
  if (!root) return {};
  return {
    server: root.server ?? root.Server,
    status: root.status ?? root.Status,
    processing: root.processing ?? root.Processing,
    message: root.message ?? root.Message,
  };
}

function parseCompanyInfoXml(xml: string): { companyName?: string; databaseName?: string; accountingPeriod?: string; year?: string } {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const doc = parser.parse(xml);
  const root = doc?.response ?? doc?.Response ?? doc;
  if (!root) return {};
  const company = root.company ?? root.Company ?? {};
  return {
    companyName: company.name ?? company.Name ?? root.companyName ?? root.CompanyName,
    databaseName: company.database ?? company.Database ?? root.database ?? root.Database,
    accountingPeriod: company.accountingPeriod ?? company.AccountingPeriod ?? root.accountingPeriod,
    year: company.year ?? company.Year ?? root.year ?? root.Year,
  };
}

export function registerSystemTools(host: ToolHost, ctx: ConnectorContext): void {
  host.tool(
    "pohoda_status",
    "Get POHODA mServer status: processing queue count, server state (idle/working), and server address. Use to check if the server is ready to accept requests.",
    {},
    async () => {
      try {
        const data = parseStatusXml(await ctx.client.getStatus());
        const lines: string[] = [];
        if (data.processing != null) lines.push(`Processing queue: ${data.processing}`);
        if (data.status != null) lines.push(`Server status: ${data.status}`);
        if (data.server != null) lines.push(`Address: ${data.server}`);
        if (data.message) lines.push(`Message: ${data.message}`);
        return ok(lines.length > 0 ? lines.join("\n") : "status returned no fields");
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_company_info",
    "Get POHODA company/accounting unit info: company name, database name, accounting period, and year. Requires authenticated connection.",
    {},
    async () => {
      try {
        const data = parseCompanyInfoXml(await ctx.client.getCompanyInfo());
        const lines: string[] = [];
        if (data.companyName) lines.push(`Company: ${data.companyName}`);
        if (data.databaseName) lines.push(`Database: ${data.databaseName}`);
        if (data.accountingPeriod) lines.push(`Accounting period: ${data.accountingPeriod}`);
        if (data.year) lines.push(`Year: ${data.year}`);
        return ok(lines.length > 0 ? lines.join("\n") : "company info returned no fields");
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  host.tool(
    "pohoda_connector_info",
    "Describe this connector instance: write mode, delete policy, sandbox flag, your principal and role, SQL availability. Read this first.",
    {},
    async () => {
      const c = ctx.config;
      return ok(
        JSON.stringify(
          {
            writeMode: c.writeMode,
            allowDelete: c.allowDelete,
            autoSendOnApprove: c.autoSendOnApprove,
            sandbox: c.sandbox,
            extSystem: c.extSystem,
            principal: ctx.principal,
            canApprove: ctx.principal.role === "human" || c.sandbox,
            sql: ctx.sql ? { database: ctx.sql.database } : null,
            ico: c.pohoda.ico,
          },
          null,
          2,
        ),
      );
    },
  );

  host.tool(
    "pohoda_download_file",
    "Download a file from POHODA documents storage. Returns file size and base64 content for files under 100KB; for larger files returns size info only. Path is relative to documents root.",
    { filePath: z.string().describe("Relative path to the file in POHODA documents storage") },
    async ({ filePath }) => {
      try {
        const buf = await ctx.client.downloadFile(filePath);
        const size = buf.length;
        const sizeKb = size / 1024;
        if (size < 100 * 1024) {
          return ok(`File size: ${size} bytes (${sizeKb.toFixed(1)} KB)\n\nBase64 content:\n${buf.toString("base64")}`);
        }
        return ok(`File size: ${size} bytes (${sizeKb.toFixed(1)} KB). File too large for inline transfer; use external download for files over 100 KB.`);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}
