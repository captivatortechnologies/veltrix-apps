import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
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
 * Runs a tool body and normalizes the result/error into a CallToolResult.
 * API failures come back as isError tool results (with the actionable hint
 * from VeltrixApiError) instead of protocol-level errors, so the assistant
 * can read the reason and adjust.
 */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2);
    return { content: [{ type: 'text', text }] };
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
