import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import {
  DESTRUCTIVE,
  READ,
  WRITE,
  WRITE_IDEMPOTENT,
  canvasIdShape,
  deploymentIdShape,
  reachesTenantTools,
  runTool,
  toolRegistrar,
  uuid,
} from './helpers';

const STRATEGIES = ['DIRECT', 'CANARY', 'BLUE_GREEN', 'ROLLING'] as const;

const deployCanvasSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  environmentId: uuid('Target environment ID (see veltrix_list_environments)'),
  strategy: z.enum(STRATEGIES).optional().describe('Overrides the environment policy’s default strategy'),
};

const listCanvasDeploymentsSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  limit: z.number().int().min(1).max(100).optional(),
};

const rollbackSchema: z.ZodRawShape = {
  deploymentId: uuid('Deployment ID'),
  reason: z.string().min(1).describe('Why the rollback is needed (recorded in the audit trail)'),
};

const promoteSchema: z.ZodRawShape = {
  deploymentId: uuid('Deployment ID of the successful deployment to promote'),
  targetEnvironmentId: uuid('Environment to promote into (see veltrix_list_environments)'),
};

export function registerPipelineTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_validate_canvas',
    {
      title: 'Validate canvas',
      description:
        'Runs the target app’s validator against a canvas configuration and returns errors and warnings. Always validate a canvas after editing it and before submitting it for approval — a canvas that fails validation cannot progress through the pipeline.',
      inputSchema: canvasIdShape,
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ canvasId }) => runTool(() => client.post(`/api/pipeline/canvas/${canvasId}/validate`)),
  );

  register(
    'veltrix_get_pipeline_status',
    {
      title: 'Get canvas pipeline status',
      description:
        'Returns where one canvas stands in the pipeline (validation, approval, deployment, drift) in a single call. Use it to answer "what is the next step for this change?".',
      inputSchema: canvasIdShape,
      annotations: READ,
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/pipeline/canvas/${canvasId}/pipeline-status`)),
  );

  register(
    'veltrix_deploy_canvas',
    {
      title: 'Deploy canvas',
      description:
        'Queues a deployment of an APPROVED canvas to a target environment. The pipeline enforces the approval requirement — deploying a canvas that has not been human-approved fails. Deployment strategy defaults to the environment policy; override with DIRECT, CANARY, BLUE_GREEN, or ROLLING. Counts against the tenant’s concurrent-deployment quota. Returns the deploymentId to track with veltrix_get_deployment.',
      inputSchema: deployCanvasSchema,
      annotations: reachesTenantTools(WRITE),
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
      annotations: READ,
    },
    async ({ canvasId, ...query }) => runTool(() => client.get(`/api/pipeline/canvas/${canvasId}/deployments`, query)),
  );

  register(
    'veltrix_get_deployment',
    {
      title: 'Get deployment status',
      description:
        'Returns the detailed status of a deployment (QUEUED, IN_PROGRESS, HEALTH_CHECKING, PAUSED, SUCCEEDED, FAILED, ROLLING_BACK, ROLLED_BACK) including health score, error rate, and canary progress. Poll this after veltrix_deploy_canvas to track a deployment to completion.',
      inputSchema: deploymentIdShape,
      annotations: READ,
    },
    async ({ deploymentId }) => runTool(() => client.get(`/api/pipeline/deployments/${deploymentId}`)),
  );

  register(
    'veltrix_pause_deployment',
    {
      title: 'Pause deployment',
      description:
        'Pauses an in-progress progressive deployment (canary / rolling) at its current stage. Use when health looks doubtful and a human should look before it proceeds. Resume with veltrix_resume_deployment or undo with veltrix_rollback_deployment.',
      inputSchema: deploymentIdShape,
      annotations: reachesTenantTools(WRITE_IDEMPOTENT),
    },
    async ({ deploymentId }) => runTool(() => client.post(`/api/pipeline/deployments/${deploymentId}/pause`)),
  );

  register(
    'veltrix_resume_deployment',
    {
      title: 'Resume deployment',
      description: 'Resumes a paused deployment from the stage where it stopped.',
      inputSchema: deploymentIdShape,
      annotations: reachesTenantTools(WRITE_IDEMPOTENT),
    },
    async ({ deploymentId }) => runTool(() => client.post(`/api/pipeline/deployments/${deploymentId}/resume`)),
  );

  register(
    'veltrix_promote_deployment',
    {
      title: 'Promote deployment to another environment',
      description:
        'Promotes a successful deployment into the next environment (for example staging → production), starting a new deployment there. The target environment’s policy and approval requirements still apply.',
      inputSchema: promoteSchema,
      annotations: reachesTenantTools(WRITE),
    },
    async ({ deploymentId, targetEnvironmentId }) =>
      runTool(() => client.post(`/api/pipeline/deployments/${deploymentId}/promote`, { targetEnvironmentId })),
  );

  register(
    'veltrix_rollback_deployment',
    {
      title: 'Rollback deployment',
      description:
        'Rolls a deployment back to the previous version. A reason is mandatory and is recorded in the audit trail. Use when a deployment is unhealthy (low health score, rising error rate) or when asked to undo a change.',
      inputSchema: rollbackSchema,
      annotations: reachesTenantTools(DESTRUCTIVE),
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
      annotations: READ,
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
      annotations: READ,
    },
    async () => runTool(() => client.get('/api/pipeline/environment-matrix')),
  );
}
