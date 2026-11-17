import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import {
  DESTRUCTIVE,
  READ,
  WRITE,
  WRITE_IDEMPOTENT,
  canvasIdShape,
  pageShape,
  reachesTenantTools,
  runTool,
  toolRegistrar,
  uuid,
} from './helpers';

const DRIFT_FREQUENCIES = ['off', 'hourly', 'daily', 'weekly'] as const;
const DRIFT_RESOLUTIONS = ['acknowledged', 'redeployed', 'verified'] as const;

const listDriftSchema: z.ZodRawShape = {
  environmentId: z.string().uuid().optional().describe('Only drift in this environment'),
  isResolved: z.boolean().optional().describe('false = only unresolved drift'),
  ...pageShape,
};

const detectDriftSchema: z.ZodRawShape = {
  environmentId: z.string().uuid().optional().describe('Limit the sweep to one environment'),
};

const resolveDriftSchema: z.ZodRawShape = {
  driftId: uuid('Drift record ID (see veltrix_list_drift)'),
  action: z
    .enum(DRIFT_RESOLUTIONS)
    .describe(
      'acknowledged = record that the drift is known (the incident stays open); redeployed / verified = re-check the live state and close the incident only if it matches again, recording how it was corrected',
    ),
};

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
    'veltrix_list_drift',
    {
      title: 'List drift records',
      description:
        'Lists configuration-drift records for the tenant — places where the live security-tool configuration no longer matches what Veltrix deployed (severity info / warning / critical, with per-field diffs). Filter by environment or resolution state. Paginated.',
      inputSchema: listDriftSchema,
      annotations: READ,
    },
    async (args) => runTool(() => client.get('/api/pipeline/drift', args)),
  );

  register(
    'veltrix_get_canvas_drift',
    {
      title: 'Get configuration drift',
      description:
        'Returns drift records for one configuration (what was deployed vs the live state) plus the async check state (CHECKING/IDLE and lastDriftCheckAt).',
      inputSchema: canvasIdShape,
      annotations: READ,
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/pipeline/configuration-canvas/${canvasId}/drift`)),
  );

  register(
    'veltrix_check_canvas_drift',
    {
      title: 'Check canvas for drift now',
      description:
        'Queues an on-demand drift check for one canvas and returns immediately (the check runs async — a managed check hashes files over the tenant network and can run audit searches). Poll veltrix_get_canvas_drift until checkState is IDLE for the results. Use when asked whether a specific configuration has been changed out-of-band.',
      inputSchema: canvasIdShape,
      annotations: reachesTenantTools(WRITE_IDEMPOTENT),
    },
    async ({ canvasId }) => runTool(() => client.post(`/api/pipeline/configuration-canvas/${canvasId}/drift/check`)),
  );

  register(
    'veltrix_detect_drift',
    {
      title: 'Run drift detection across deployed configurations',
      description:
        'Checks every deployed configuration for drift right now (optionally one environment) and returns the unresolved records. Heavier than veltrix_check_canvas_drift — prefer that when the question is about a single configuration. Rate limited.',
      inputSchema: detectDriftSchema,
      annotations: reachesTenantTools(WRITE_IDEMPOTENT),
    },
    async (args) => runTool(() => client.post('/api/pipeline/drift/detect', args)),
  );

  register(
    'veltrix_resolve_drift',
    {
      title: 'Acknowledge or resolve a drift incident',
      description:
        'Acknowledges or closes a drift incident. "verified" and "redeployed" re-check the live configuration and close the incident only when it matches what was deployed (otherwise the call fails and the incident stays open). "acknowledged" marks the incident as known without closing it — use it only when the user has said so. Recorded under this API key’s identity.',
      inputSchema: resolveDriftSchema,
      annotations: WRITE,
    },
    async ({ driftId, action }) => runTool(() => client.post(`/api/pipeline/drift/${driftId}/resolve`, { action })),
  );

  register(
    'veltrix_get_drift_schedule',
    {
      title: 'Get drift-check schedule',
      description: 'Returns the tenant default drift-check frequency and any per-app overrides.',
      inputSchema: {},
      annotations: READ,
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
      annotations: WRITE_IDEMPOTENT,
    },
    async (args) => runTool(() => client.put('/api/pipeline/drift/schedule', args)),
  );

  register(
    'veltrix_clear_drift_schedule',
    {
      title: 'Clear a per-app drift-check override',
      description: 'Removes an app’s per-app drift-check override so it inherits the tenant default again.',
      inputSchema: clearScheduleSchema,
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async ({ appId }) => runTool(() => client.delete(`/api/pipeline/drift/schedule/${encodeURIComponent(String(appId))}`)),
  );
}
