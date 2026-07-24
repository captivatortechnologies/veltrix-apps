import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { runTool, toolRegistrar } from './helpers';

// Schemas are annotated as ZodRawShape to keep tsc from materializing the
// SDK's deep generic inference (TS2589). Handlers receive loosely-typed args.
const listDriftSchema: z.ZodRawShape = {
  environmentId: z.string().uuid().optional(),
  isResolved: z.boolean().optional().describe('false = only unresolved drift'),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

const canvasIdSchema: z.ZodRawShape = { canvasId: z.string().uuid() };

export function registerTelemetryTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_list_drift',
    {
      title: 'List drift records',
      description:
        'Lists configuration-drift records for the tenant — places where the live security-tool configuration no longer matches what Veltrix deployed (severity info / warning / critical, with per-field diffs). Filter by environment or resolution state. Paginated.',
      inputSchema: listDriftSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(() => client.get('/api/pipeline/drift', args)),
  );

  register(
    'veltrix_check_canvas_drift',
    {
      title: 'Check canvas for drift now',
      description:
        'Queues an on-demand drift check for one canvas and returns immediately (the check runs async — a managed check hashes files over the tenant network and can run audit searches). Poll veltrix_get_canvas_drift until checkState is IDLE for the results. Use when asked whether a specific configuration has been changed out-of-band.',
      inputSchema: canvasIdSchema,
    },
    async ({ canvasId }) => runTool(() => client.post(`/api/pipeline/configuration-canvas/${canvasId}/drift/check`)),
  );

  register(
    'veltrix_compliance_report',
    {
      title: 'Compliance report',
      description:
        'Returns the tenant’s compliance report: frameworks, control coverage, and evidence derived from real pipeline activity. Note: Veltrix provides change-governance controls and evidence that support compliance programs; the report is not by itself a legal or regulatory compliance determination.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/reports/compliance')),
  );

  register(
    'veltrix_security_overview',
    {
      title: 'Security overview report',
      description:
        'Returns the tenant’s derived security-posture overview: deployment health, drift posture, approval hygiene, and other governance signals aggregated from real tenant data.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/reports/security-overview')),
  );
}
