import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from './veltrix-client';
import { registerPrompts } from './prompts';
import { registerIdentityTools } from './tools/identity';
import { registerCanvasTools } from './tools/canvases';
import { registerVersionTools } from './tools/versions';
import { registerApprovalTools } from './tools/approvals';
import { registerReviewTools } from './tools/review';
import { registerPipelineTools } from './tools/pipeline';
import { registerDriftTools } from './tools/drift';
import { registerReportTools } from './tools/reports';
import { registerCatalogTools } from './tools/catalog';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };

export const SERVER_VERSION = pkg.version;

export interface BuildServerOptions {
  apiUrl: string;
  apiKey: string;
  /** Per-request API timeout in ms (VELTRIX_API_TIMEOUT_MS; default 30s). */
  timeoutMs?: number;
}

const INSTRUCTIONS = [
  'Veltrix is a multi-tenant Security-as-Code platform that governs security-tool configuration',
  'changes through a pipeline: Draft -> Validate -> Human Approval -> Progressive Deployment -> Drift Detection.',
  'This MCP server is propose-only: you can draft, validate, and submit configuration changes and',
  'trigger deployments of already-approved canvases, but approval decisions are made by humans in the',
  'Veltrix portal. They are not available here, and the Veltrix API refuses them for API keys.',
  'Start with veltrix_whoami to confirm the key, tenant and plan (what you may do is set by the key’s role); use',
  'veltrix_pipeline_summary for a state-of-the-world overview.',
  'To draft a change: veltrix_list_apps -> veltrix_get_app -> veltrix_get_config_type_schema ->',
  'veltrix_create_canvas -> veltrix_validate_canvas -> veltrix_list_approvers ->',
  'veltrix_submit_canvas_for_approval. Never invent field names, approvers or environment ids — look them up.',
  'Ask the user before deploying, rolling back, deleting, or acknowledging drift.',
].join(' ');

/**
 * Builds a Veltrix MCP server bound to one API key. The server is a thin,
 * propose-only adapter over the Veltrix REST API: every tool forwards the key,
 * and tenant isolation / RBAC / quotas are enforced by the Veltrix API itself.
 */
export function buildMcpServer(options: BuildServerOptions): McpServer {
  const client = new VeltrixClient(options.apiUrl, options.apiKey, {
    timeoutMs: options.timeoutMs,
    enforceEntitlement: true,
  });

  const server = new McpServer({ name: 'veltrix', version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  registerIdentityTools(server, client);
  registerCatalogTools(server, client);
  registerCanvasTools(server, client);
  registerVersionTools(server, client);
  registerApprovalTools(server, client);
  registerReviewTools(server, client);
  registerPipelineTools(server, client);
  registerDriftTools(server, client);
  registerReportTools(server, client);
  registerPrompts(server);

  return server;
}
