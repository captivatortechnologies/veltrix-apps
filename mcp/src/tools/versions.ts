import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { READ, WRITE, runTool, toolRegistrar, uuid } from './helpers';

const historySchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  limit: z.number().int().min(1).max(100).optional().describe('Number of versions to return (default 20)'),
};

const versionSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  historyId: uuid('Version (history entry) ID from veltrix_get_canvas_history'),
};

const compareSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  historyId1: uuid('First version (history entry) ID'),
  historyId2: uuid('Second version (history entry) ID'),
};

export function registerVersionTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_get_canvas_history',
    {
      title: 'Get canvas version history',
      description:
        'Returns the version history of a canvas, newest first: who changed it, when, and what kind of action it was. The entry ids are the historyId values used by the version, compare and restore tools.',
      inputSchema: historySchema,
      annotations: READ,
    },
    async ({ canvasId, limit }) => runTool(() => client.get(`/api/configuration-canvas/${canvasId}/history`, { limit })),
  );

  register(
    'veltrix_get_canvas_version',
    {
      title: 'Get one canvas version',
      description: 'Returns the full snapshot of a canvas as it was at one version.',
      inputSchema: versionSchema,
      annotations: READ,
    },
    async ({ canvasId, historyId }) =>
      runTool(() => client.get(`/api/configuration-canvas/${canvasId}/versions/${historyId}`)),
  );

  register(
    'veltrix_compare_canvas_versions',
    {
      title: 'Compare two canvas versions',
      description:
        'Returns a field-level diff between two versions of a canvas. Use it to explain exactly what a proposed change alters, or to find what changed before a failed deployment.',
      inputSchema: compareSchema,
      annotations: READ,
    },
    async ({ canvasId, historyId1, historyId2 }) =>
      runTool(() => client.get(`/api/configuration-canvas/${canvasId}/compare`, { historyId1, historyId2 })),
  );

  register(
    'veltrix_restore_canvas_version',
    {
      title: 'Restore a canvas version',
      description:
        'Restores a canvas’s content to an earlier version, recorded as a new version in the history (nothing is lost). This edits the canvas only — it does not deploy; a restored canvas goes through validation and human approval like any other change. To undo a live deployment use veltrix_rollback_deployment.',
      inputSchema: versionSchema,
      annotations: WRITE,
    },
    async ({ canvasId, historyId }) =>
      runTool(() => client.post(`/api/configuration-canvas/${canvasId}/versions/${historyId}/restore`)),
  );
}
