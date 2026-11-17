import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { DESTRUCTIVE, READ, WRITE, canvasIdShape, pageShape, runTool, toolRegistrar, uuid } from './helpers';

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
  .array(z.record(z.string(), z.unknown()))
  .describe(
    'Canvas sections: each section has name, order, and a fields array (key, label, fieldType, value, required, order). Get the exact sections and fields for a configuration type from veltrix_get_config_type_schema, or copy the shape of an existing canvas from veltrix_get_canvas.',
  );

// Schemas are annotated as ZodRawShape to keep tsc from materializing the
// SDK's deep generic inference (TS2589). Handlers receive loosely-typed args.
const listCanvasesSchema: z.ZodRawShape = {
  toolType: z.string().optional().describe('Filter by app slug, e.g. "splunk-enterprise" (see veltrix_list_apps)'),
  entityType: z.string().optional().describe('Filter by configuration type id'),
  status: z.enum(CANVAS_STATUSES).optional().describe('Filter by lifecycle status'),
  ...pageShape,
};

const createCanvasSchema: z.ZodRawShape = {
  name: z.string().min(1).max(255),
  toolType: z.string().min(1).describe('Target app slug, e.g. "splunk-enterprise" (see veltrix_list_apps)'),
  entityType: z.string().min(1).describe('Configuration type id for that app (see veltrix_get_app)'),
  description: z.string().optional(),
  sections: sectionsSchema.optional(),
};

const updateCanvasSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  sections: sectionsSchema.optional(),
};

const duplicateCanvasSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID to copy'),
  name: z.string().min(1).max(255).describe('Name for the new draft copy'),
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
      annotations: READ,
    },
    async (args) => runTool(() => client.get('/api/configuration-canvas', args)),
  );

  register(
    'veltrix_get_canvas',
    {
      title: 'Get configuration canvas',
      description:
        'Returns one configuration canvas in full, including its sections and fields, lifecycle status, version, and audit fields. Use this to inspect a configuration before proposing changes.',
      inputSchema: canvasIdShape,
      annotations: READ,
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/configuration-canvas/${canvasId}`)),
  );

  register(
    'veltrix_create_canvas',
    {
      title: 'Create configuration canvas (draft)',
      description:
        'Creates a new DRAFT configuration canvas — this is a proposal only; nothing is deployed until the canvas is validated, approved by a human in the Veltrix portal, and deployed through the pipeline. Before calling this, use veltrix_get_app to pick the configuration type (entityType) and veltrix_get_config_type_schema to learn its sections, fields and defaults. Requires the configuration-canvas write permission and counts against the tenant’s canvas quota.',
      inputSchema: createCanvasSchema,
      annotations: WRITE,
    },
    async (args) => runTool(() => client.post('/api/configuration-canvas', args)),
  );

  register(
    'veltrix_update_canvas',
    {
      title: 'Update configuration canvas',
      description:
        'Updates a configuration canvas (name, description, sections). Edits are versioned in the canvas history. Only sensible on DRAFT / CHANGES_REQUESTED canvases — approved or deployed canvases should be re-proposed instead. Re-run veltrix_validate_canvas afterwards.',
      inputSchema: updateCanvasSchema,
      annotations: WRITE,
    },
    async ({ canvasId, ...body }) => runTool(() => client.put(`/api/configuration-canvas/${canvasId}`, body)),
  );

  register(
    'veltrix_duplicate_canvas',
    {
      title: 'Duplicate configuration canvas',
      description:
        'Copies a canvas into a new DRAFT with the given name. Use this to re-propose a change to an approved or deployed configuration without touching the original. Counts against the tenant’s canvas quota.',
      inputSchema: duplicateCanvasSchema,
      annotations: WRITE,
    },
    async ({ canvasId, name }) =>
      runTool(() => client.post(`/api/configuration-canvas/${canvasId}/duplicate`, { name })),
  );

  register(
    'veltrix_export_canvas',
    {
      title: 'Export configuration canvas',
      description:
        'Returns a portable export of a canvas (name, description, toolType, entityType, sections, version) — a compact form suited to reviewing or re-creating a configuration.',
      inputSchema: canvasIdShape,
      annotations: READ,
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/configuration-canvas/${canvasId}/export`)),
  );

  register(
    'veltrix_delete_canvas',
    {
      title: 'Delete a configuration canvas',
      description:
        'Permanently deletes a configuration canvas. Use for abandoned drafts or superseded configurations. Deploying and deployed configurations may be protected by the platform — check the canvas status first.',
      inputSchema: canvasIdShape,
      annotations: DESTRUCTIVE,
    },
    async ({ canvasId }) => runTool(() => client.delete(`/api/configuration-canvas/${canvasId}`)),
  );
}
