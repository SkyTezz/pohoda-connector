import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { err, type ToolResult } from "./types.js";

/**
 * One registration, two front doors.
 *
 * Tools register once through `ToolHost.tool(...)` (the same signature as
 * `McpServer.tool`). The registry forwards to the MCP server when one is
 * attached and keeps its own map so the REST facade can validate and invoke
 * the identical handler without going through an MCP transport.
 */
export type ToolHandler<Shape extends ZodRawShape> = (
  args: z.objectOutputType<Shape, z.ZodTypeAny>,
) => Promise<ToolResult> | ToolResult;

export interface ToolHost {
  tool<Shape extends ZodRawShape>(name: string, description: string, schema: Shape, handler: ToolHandler<Shape>): void;
}

interface RegisteredTool {
  description: string;
  schema: ZodRawShape;
  handler: (args: unknown) => Promise<ToolResult> | ToolResult;
}

/** Opens the scope of one accounting unit around a tool call (`Units.run`). */
export type UnitScope = <T>(accountingUnit: string | undefined, fn: () => T) => T;

const accountingUnitArg = z
  .string()
  .optional()
  .describe("IČO of the accounting unit this call is for (see pohoda_connector_info); may be omitted when the connector serves one unit");

export class ToolRegistry implements ToolHost {
  private readonly tools = new Map<string, RegisteredTool>();
  private unitScope: UnitScope | undefined;

  constructor(private readonly server?: McpServer) {}

  /**
   * Tools registered inside `register` talk to an mServer, and which one depends on the accounting
   * unit. They all get an `accountingUnit` argument here, in one place, and their handler runs inside
   * that unit's scope; the handlers themselves stay unaware of units.
   */
  forEachUnit(scope: UnitScope, register: () => void): void {
    this.unitScope = scope;
    try {
      register();
    } finally {
      this.unitScope = undefined;
    }
  }

  tool<Shape extends ZodRawShape>(name: string, description: string, schema: Shape, handler: ToolHandler<Shape>): void {
    if (this.tools.has(name)) throw new Error(`tool registered twice: ${name}`);
    const scope = this.unitScope;
    if (scope) return this.add(name, description, { ...schema, accountingUnit: accountingUnitArg }, inUnit(scope, handler as RegisteredTool["handler"]));
    this.add(name, description, schema, handler as RegisteredTool["handler"]);
  }

  private add(name: string, description: string, schema: ZodRawShape, handler: RegisteredTool["handler"]): void {
    this.tools.set(name, { description, schema, handler });
    // The SDK's overloads are stricter about the callback's result type than our
    // ToolResult (a plain text-content result); the shape is compatible at runtime.
    const mcpTool = this.server?.tool as
      | ((n: string, d: string, s: ZodRawShape, cb: (a: unknown) => Promise<ToolResult> | ToolResult) => unknown)
      | undefined;
    mcpTool?.call(this.server, name, description, schema, (args: unknown) => handler(args));
  }

  list(): Array<{ name: string; description: string; parameters: string[] }> {
    return [...this.tools.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      parameters: Object.keys(t.schema),
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async call(name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    const parsed = z.object(tool.schema).strict().safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new Error(`invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
    return tool.handler(parsed.data);
  }
}

/** The handler without `accountingUnit` in its arguments, run in that unit's scope; an unknown unit is a tool error. */
function inUnit(scope: UnitScope, handler: RegisteredTool["handler"]): RegisteredTool["handler"] {
  return async (args) => {
    const { accountingUnit, ...rest } = (args ?? {}) as { accountingUnit?: string } & Record<string, unknown>;
    try {
      return await scope(accountingUnit, () => handler(rest));
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
