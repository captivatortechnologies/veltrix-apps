import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { runTool, toolRegistrar } from './helpers';

const STRATEGIES = ['DIRECT', 'CANARY', 'BLUE_GREEN', 'ROLLING'] as const;

// Schemas are annotated as ZodRawShape to keep tsc from materializing the
// SDK's deep generic inference (TS2589). Handlers receive loosely-typed args.
const canvasIdSchema: z.ZodRawShape = { canvasId: z.string().uuid() };
const deploymentIdSchema: z.ZodRawShape = { deploymentId: z.string().uuid() };

const deployCanvasSchema: z.ZodRawShape = {
  canvasId: z.string().uuid(),
  environmentId: z.string().uuid().describe('Target environment ID (see veltrix_list_environments)'),
  strategy: z.enum(STRATEGIES).optional(),
};

const listCanvasDeploymentsSchema: z.ZodRawShape = {
  canvasId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).optional(),
};

const rollbackSchema: z.ZodRawShape = {
  deploymentId: z.string().uuid(),
  reason: z.string().min(1).describe('Why the rollback is needed (recorded in the audit trail)'),
};

export function registerPipelineTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_validate_canvas',
    {
      title: 'Validate canvas',
      description:
        'Runs the target app’s validator against a canvas configuration and returns errors and warnings. Always validate a canvas after editing it and before submitting it for approval — a canvas that fails validation cannot progress through the pipeline.',
      inputSchema: canvasIdSchema,
    },
    async ({ canvasId }) => runTool(() => client.post(`/api/pipeline/canvas/${canvasId}/validate`)),
  );

  register(
    'veltrix_deploy_canvas',
    {
      title: 'Deploy canvas',
      description:
        'Queues a deployment of an APPROVED canvas to a target environment. The pipeline enforces the approval requirement — deploying a canvas that has not been human-approved fails. Deployment strategy defaults to the environment policy; override with DIRECT, CANARY, BLUE_GREEN, or ROLLING. Counts against the tenant’s concurrent-deployment quota. Returns the deploymentId to track with veltrix_get_deployment.',
      inputSchema: deployCanvasSchema,
    },
    async ({ canvasId, ...body }) => runTool(() => client.post(`/api/pipeline/canvas/${canvasId}/deploy`, body)),
  );

  register(
    'veltrix_list_canvas_deployments',
    {
      title: 'List canvas deployments',
      description:
        'Returns the deployment history for one canvas, newest first, including status, strategy, health score, and who triggered each deployment.',
      inputSchema: listCanvasDeploymentsSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ canvasId, ...query }) => runTool(() => client.get(`/api/pipeline/canvas/${canvasId}/deployments`, query)),
  );

  register(
    'veltrix_get_deployment',
    {
      title: 'Get deployment status',
      description:
        'Returns the detailed status of a deployment (QUEUED, IN_PROGRESS, HEALTH_CHECKING, PAUSED, SUCCEEDED, FAILED, ROLLING_BACK, ROLLED_BACK) including health score, error rate, and canary progress. Poll this after veltrix_deploy_canvas to track a deployment to completion.',
      inputSchema: deploymentIdSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ deploymentId }) => runTool(() => client.get(`/api/pipeline/deployments/${deploymentId}`)),
  );

  register(
    'veltrix_rollback_deployment',
    {
      title: 'Rollback deployment',
      description:
        'Rolls a deployment back to the previous version. A reason is mandatory and is recorded in the audit trail. Use when a deployment is unhealthy (low health score, rising error rate) or when asked to undo a change.',
      inputSchema: rollbackSchema,
      annotations: { destructiveHint: true },
    },
    async ({ deploymentId, reason }) =>
      runTool(() => client.post(`/api/pipeline/deployments/${deploymentId}/rollback`, { reason })),
  );

  register(
    'veltrix_pipeline_summary',
    {
      title: 'Pipeline summary',
      description:
        'Returns the tenant’s pipeline dashboard numbers: pending validations, pending human approvals, active deployments, failed deployments, and unresolved drift records. A good first call when asked "what’s the state of our security configs?".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/pipeline/summary')),
  );

  register(
    'veltrix_environment_matrix',
    {
      title: 'Environment deployment matrix',
      description:
        'Returns a matrix of every canvas and its deployment status per environment (e.g. dev / staging / prod) — which version is where, with health and timing. Use this to answer "what is deployed where?".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/pipeline/environment-matrix')),
  );
}
