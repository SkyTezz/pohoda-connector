import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { ToolResult } from "./types.js";

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

export class ToolRegistry implements ToolHost {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly server?: McpServer) {}

  tool<Shape extends ZodRawShape>(name: string, description: string, schema: Shape, handler: ToolHandler<Shape>): void {
    if (this.tools.has(name)) throw new Error(`tool registered twice: ${name}`);
    this.tools.set(name, { description, schema, handler: handler as RegisteredTool["handler"] });
    // The SDK's overloads are stricter about the callback's result type than our
    // ToolResult (a plain text-content result); the shape is compatible at runtime.
    const mcpTool = this.server?.tool as
      | ((n: string, d: string, s: ZodRawShape, cb: (a: unknown) => Promise<ToolResult> | ToolResult) => unknown)
      | undefined;
    mcpTool?.call(this.server, name, description, schema, (args: unknown) => handler(args as z.objectOutputType<Shape, z.ZodTypeAny>));
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
