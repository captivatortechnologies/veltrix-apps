import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { READ, WRITE, runTool, toolRegistrar, uuid } from './helpers';

const listCommentsSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  historyId: z.string().uuid().optional().describe('Only comments anchored to this version (see veltrix_get_canvas_history)'),
};

const addCommentSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  body: z.string().min(1).describe('Comment text'),
  parentId: z.string().uuid().optional().describe('Comment ID to reply to'),
  historyId: z.string().uuid().optional().describe('Version to anchor the comment to'),
};

export function registerReviewTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_list_canvas_comments',
    {
      title: 'List review comments',
      description:
        'Returns the threaded review comments on a canvas. When a canvas is CHANGES_REQUESTED, read these to learn what the reviewers asked for before editing it.',
      inputSchema: listCommentsSchema,
      annotations: READ,
    },
    async ({ canvasId, historyId }) =>
      runTool(() => client.get(`/api/configuration-canvas/${canvasId}/comments`, { historyId })),
  );

  register(
    'veltrix_add_canvas_comment',
    {
      title: 'Add a review comment',
      description:
        'Adds a comment to a canvas review thread, or replies to an existing comment with parentId. Use it to explain a proposed change or to answer a reviewer. The comment is attributed to this API key’s identity.',
      inputSchema: addCommentSchema,
      annotations: WRITE,
    },
    async ({ canvasId, ...body }) => runTool(() => client.post(`/api/configuration-canvas/${canvasId}/comments`, body)),
  );
}
