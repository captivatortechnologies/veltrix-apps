import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { VeltrixApiError } from '../veltrix-client';

export interface VeltrixToolConfig {
  title?: string;
  description?: string;
  inputSchema?: ZodRawShape;
  annotations?: ToolAnnotations;
}

export type VeltrixToolHandler = (args: Record<string, any>) => Promise<CallToolResult>;

/**
 * Generic-erased view of server.registerTool. The SDK's registerTool generics
 * make tsc materialize zod's deep inference for every schema shape and fail
 * with TS2589 ("type instantiation is excessively deep"); erasing the generics
 * sidesteps that with identical runtime behavior (registerTool never consults
 * the generics at runtime). Handlers receive loosely-typed args — runtime
 * validation still happens in the SDK against the zod schemas.
 */
export function toolRegistrar(
  server: McpServer,
): (name: string, config: VeltrixToolConfig, handler: VeltrixToolHandler) => void {
  return server.registerTool.bind(server) as unknown as (
    name: string,
    config: VeltrixToolConfig,
    handler: VeltrixToolHandler,
  ) => void;
}

/**
 * Annotation presets. openWorldHint is false for everything that only reads or
 * edits Veltrix's own records, and true where the call reaches the tenant's
 * security tools (deployments, rollbacks, live drift checks).
 */
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
export const reachesTenantTools = (annotations: ToolAnnotations): ToolAnnotations => ({
  ...annotations,
  openWorldHint: true,
});

export const uuid = (description: string) => z.string().uuid().describe(description);
export const canvasIdShape: ZodRawShape = { canvasId: uuid('Canvas ID (see veltrix_list_canvases)') };
export const deploymentIdShape: ZodRawShape = {
  deploymentId: uuid('Deployment ID (see veltrix_list_canvas_deployments)'),
};
export const pageShape: ZodRawShape = {
  page: z.number().int().min(1).optional().describe('1-based page number'),
  limit: z.number().int().min(1).max(100).optional().describe('Items per page (max 100)'),
};

/** Keeps one oversized payload from flooding the assistant's context window. */
export const DEFAULT_MAX_RESULT_CHARS = 60_000;

export function maxResultChars(): number {
  const configured = Number(process.env.VELTRIX_MCP_MAX_RESULT_CHARS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_RESULT_CHARS;
}

export function capResultText(text: string, limit: number = maxResultChars()): string {
  if (text.length <= limit) return text;
  return (
    `[Truncated: the response was ${text.length} characters; showing the first ${limit}. ` +
    'Narrow the request with the tool’s filters or page/limit arguments, or fetch a single item by id. ' +
    'The JSON below is cut off and will not parse.]\n' +
    text.slice(0, limit)
  );
}

/**
 * Runs a tool body and normalizes the result/error into a CallToolResult.
 * API failures come back as isError tool results (with the actionable hint
 * from VeltrixApiError) instead of protocol-level errors, so the assistant
 * can read the reason and adjust.
 */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2);
    return { content: [{ type: 'text', text: capResultText(text) }] };
  } catch (error) {
    if (error instanceof VeltrixApiError) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: 'text', text: `Unexpected error calling the Veltrix API: ${message}` }],
    };
  }
}
