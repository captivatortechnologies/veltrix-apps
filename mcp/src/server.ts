import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from './veltrix-client';
import { registerIdentityTools } from './tools/identity';
import { registerCanvasTools } from './tools/canvases';
import { registerPipelineTools } from './tools/pipeline';
import { registerDriftTools } from './tools/drift';
import { registerTelemetryTools } from './tools/telemetry';
import { registerCatalogTools } from './tools/catalog';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };

export interface BuildServerOptions {
  apiUrl: string;
  apiKey: string;
  /** Per-request API timeout in ms (VELTRIX_API_TIMEOUT_MS; default 30s). */
  timeoutMs?: number;
}

/**
 * Builds a Veltrix MCP server bound to one API key. The server is a thin,
 * propose-only adapter over the Veltrix REST API: every tool forwards the key,
 * and tenant isolation / RBAC / quotas are enforced by the Veltrix API itself.
 * Approval decisions are deliberately NOT exposed as tools — they stay human.
 */
export function buildMcpServer(options: BuildServerOptions): McpServer {
  const client = new VeltrixClient(options.apiUrl, options.apiKey, {
    timeoutMs: options.timeoutMs,
    // Tier gate: tools refuse with an upgrade message when the tenant's plan
    // doesn't include MCP access (free tier). Checked once, server-side.
    enforceEntitlement: true,
  });

  const server = new McpServer(
    { name: 'veltrix', version: pkg.version },
    {
      instructions: [
        'Veltrix is a multi-tenant Security-as-Code platform that governs security-tool configuration',
        'changes through a pipeline: Draft -> Validate -> Human Approval -> Progressive Deployment -> Drift Detection.',
        'This MCP server is propose-only: you can draft, validate, and submit configuration changes and',
        'trigger deployments of already-approved canvases, but approval decisions are made by humans in the',
        'Veltrix portal and are not available here. Start with veltrix_whoami to see the tenant and the',
        'permissions your API key grants; use veltrix_pipeline_summary for a state-of-the-world overview.',
      ].join(' '),
    },
  );

  registerIdentityTools(server, client);
  registerCanvasTools(server, client);
  registerPipelineTools(server, client);
  registerDriftTools(server, client);
  registerTelemetryTools(server, client);
  registerCatalogTools(server, client);

  return server;
}
