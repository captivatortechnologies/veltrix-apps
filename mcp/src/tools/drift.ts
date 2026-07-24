import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { runTool, toolRegistrar } from './helpers';

const DRIFT_FREQUENCIES = ['off', 'hourly', 'daily', 'weekly'] as const;

const canvasIdSchema: z.ZodRawShape = { canvasId: z.string().uuid().describe('Canvas ID') };

const setScheduleSchema: z.ZodRawShape = {
  frequency: z.enum(DRIFT_FREQUENCIES).describe('How often the scheduled sweep checks for drift'),
  appId: z
    .string()
    .optional()
    .describe('App slug for a per-app override (wins over the tenant default); omit for the tenant default'),
};

const clearScheduleSchema: z.ZodRawShape = {
  appId: z.string().describe('App slug whose per-app override to clear (reverts to the tenant default)'),
};

export function registerDriftTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_get_canvas_drift',
    {
      title: 'Get configuration drift',
      description:
        'Returns drift records for one configuration (what was deployed vs the live state) plus the async check state (CHECKING/IDLE and lastDriftCheckAt). Read-only.',
      inputSchema: canvasIdSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/pipeline/configuration-canvas/${canvasId}/drift`)),
  );

  register(
    'veltrix_get_drift_schedule',
    {
      title: 'Get drift-check schedule',
      description: 'Returns the tenant default drift-check frequency and any per-app overrides. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/pipeline/drift/schedule')),
  );

  register(
    'veltrix_set_drift_schedule',
    {
      title: 'Set drift-check schedule',
      description:
        'Sets how often the scheduled sweep checks for drift: the tenant default (omit appId) or a per-app override (set appId, which wins over the tenant default). frequency is off | hourly | daily | weekly ("off" disables the scheduled check; on-demand still works).',
      inputSchema: setScheduleSchema,
      annotations: {},
    },
    async (args) => runTool(() => client.put('/api/pipeline/drift/schedule', args)),
  );

  register(
    'veltrix_clear_drift_schedule',
    {
      title: 'Clear a per-app drift-check override',
      description: 'Removes an app’s per-app drift-check override so it inherits the tenant default again.',
      inputSchema: clearScheduleSchema,
      annotations: { destructiveHint: true },
    },
    async ({ appId }) => runTool(() => client.delete(`/api/pipeline/drift/schedule/${encodeURIComponent(String(appId))}`)),
  );
}
