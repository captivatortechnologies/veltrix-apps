import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { runTool, toolRegistrar } from './helpers';

const CANVAS_STATUSES = [
  'DRAFT',
  'VALIDATION_PENDING',
  'VALIDATION_FAILED',
  'PENDING_APPROVAL',
  'APPROVED',
  'DEPLOYMENT_QUEUED',
  'DEPLOYING',
  'DEPLOYMENT_PAUSED',
  'DEPLOYED',
  'DEPLOYMENT_FAILED',
  'ROLLED_BACK',
  'ARCHIVED',
  'CHANGES_REQUESTED',
] as const;

const sectionsSchema = z
  .array(z.record(z.unknown()))
  .describe(
    'Canvas sections array matching the Veltrix canvas schema: each section has name, order, and a fields array (key, label, fieldType, value, required, order). Call veltrix_get_canvas on an existing canvas to see the exact shape before constructing one.',
  );

// Schemas are annotated as ZodRawShape to keep tsc from materializing the
// SDK's deep generic inference (TS2589). Handlers receive loosely-typed args.
const canvasIdSchema: z.ZodRawShape = { canvasId: z.string().uuid().describe('Canvas ID') };

const listCanvasesSchema: z.ZodRawShape = {
  toolType: z.string().optional().describe('Filter by tool/app slug, e.g. "splunk-enterprise"'),
  entityType: z.string().optional().describe('Filter by configuration entity type'),
  status: z.enum(CANVAS_STATUSES).optional().describe('Filter by lifecycle status'),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

const createCanvasSchema: z.ZodRawShape = {
  name: z.string().min(1).max(255),
  toolType: z.string().min(1).describe('Target tool/app slug, e.g. "splunk-enterprise"'),
  entityType: z.string().min(1).describe('Configuration entity type for the target tool'),
  description: z.string().optional(),
  sections: sectionsSchema.optional(),
};

const updateCanvasSchema: z.ZodRawShape = {
  canvasId: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  sections: sectionsSchema.optional(),
};

const submitForApprovalSchema: z.ZodRawShape = {
  canvasId: z.string().uuid(),
  approverIds: z.array(z.string().uuid()).min(1).describe('User IDs of the designated human approvers'),
  environmentTagIds: z.array(z.string().uuid()).optional().describe('Target environment tag IDs'),
  comment: z.string().optional().describe('Context for the approvers: what changed and why'),
};

export function registerCanvasTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_list_canvases',
    {
      title: 'List configuration canvases',
      description:
        'Lists the tenant’s security-tool configuration canvases (the unit of change in Veltrix). Use this to discover existing configurations before creating new ones. Filter by toolType (e.g. "splunk-enterprise"), entityType, or lifecycle status. Paginated.',
      inputSchema: listCanvasesSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(() => client.get('/api/configuration-canvas', args)),
  );

  register(
    'veltrix_get_canvas',
    {
      title: 'Get configuration canvas',
      description:
        'Returns one configuration canvas in full, including its sections and fields, lifecycle status, version, and audit fields. Use this to inspect a configuration before proposing changes, and to learn the exact sections/fields shape for veltrix_create_canvas / veltrix_update_canvas.',
      inputSchema: canvasIdSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/configuration-canvas/${canvasId}`)),
  );

  register(
    'veltrix_create_canvas',
    {
      title: 'Create configuration canvas (draft)',
      description:
        'Creates a new DRAFT configuration canvas — this is a proposal only; nothing is deployed until the canvas is validated, approved by a human in the Veltrix portal, and deployed through the pipeline. Requires the configuration-canvas write permission and counts against the tenant’s canvas quota.',
      inputSchema: createCanvasSchema,
    },
    async (args) => runTool(() => client.post('/api/configuration-canvas', args)),
  );

  register(
    'veltrix_update_canvas',
    {
      title: 'Update configuration canvas',
      description:
        'Updates a configuration canvas (name, description, sections). Edits are versioned in the canvas history. Only sensible on DRAFT / CHANGES_REQUESTED canvases — approved or deployed canvases should be re-proposed instead.',
      inputSchema: updateCanvasSchema,
    },
    async ({ canvasId, ...body }) => runTool(() => client.put(`/api/configuration-canvas/${canvasId}`, body)),
  );

  register(
    'veltrix_submit_canvas_for_approval',
    {
      title: 'Submit canvas for human approval',
      description:
        'Submits a canvas for approval by named human approvers — the approval decision itself always happens in the Veltrix portal and cannot be made through this MCP server. Provide the user IDs of the designated approvers and an optional comment explaining the proposed change.',
      inputSchema: submitForApprovalSchema,
    },
    async ({ canvasId, ...body }) =>
      runTool(() => client.post(`/api/configuration-canvas/${canvasId}/submit-for-approval`, body)),
  );

  register(
    'veltrix_get_canvas_approvals',
    {
      title: 'Get canvas approval status',
      description:
        'Returns the approval state of a canvas: every assigned approver, their decision (PENDING / APPROVED / REJECTED), comments, and a summary. Use this to check whether a proposed change has been approved by humans before attempting to deploy it.',
      inputSchema: canvasIdSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/configuration-canvas/${canvasId}/approvals`)),
  );

  register(
    'veltrix_delete_canvas',
    {
      title: 'Delete a configuration canvas',
      description:
        'Permanently deletes a configuration canvas. Use for abandoned drafts or superseded configurations. Deploying and deployed configurations may be protected by the platform — check the canvas status first.',
      inputSchema: canvasIdSchema,
      annotations: { destructiveHint: true },
    },
    async ({ canvasId }) => runTool(() => client.delete(`/api/configuration-canvas/${canvasId}`)),
  );
}
