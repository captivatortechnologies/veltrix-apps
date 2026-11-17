import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { READ, WRITE, canvasIdShape, runTool, toolRegistrar, uuid } from './helpers';

// Approval DECISIONS are deliberately absent from this file and from the whole
// server: the Veltrix API refuses them for API keys, and there is no tool.

const submitForApprovalSchema: z.ZodRawShape = {
  canvasId: uuid('Canvas ID'),
  approverIds: z
    .array(z.string().uuid())
    .min(1)
    .describe('User IDs of the human approvers (see veltrix_list_approvers). API key identities are refused.'),
  environmentTagIds: z.array(z.string().uuid()).optional().describe('Target environment tag IDs'),
  comment: z.string().optional().describe('Context for the approvers: what changed and why'),
};

interface TenantUser {
  id: string;
  name?: string | null;
  email?: string;
  role?: string;
}

export function registerApprovalTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_list_approvers',
    {
      title: 'List people who can be named as approvers',
      description:
        'Lists the people in the tenant (id, name, email, role) so you can pick approverIds for veltrix_submit_canvas_for_approval. Ask the user who should approve when it is not obvious — do not guess. Requires the user read permission on the API key’s role.',
      inputSchema: {},
      annotations: READ,
    },
    async () =>
      runTool(async () => {
        const users = await client.get<TenantUser[]>('/api/users');
        return (Array.isArray(users) ? users : []).map(({ id, name, email, role }) => ({ id, name, email, role }));
      }),
  );

  register(
    'veltrix_submit_canvas_for_approval',
    {
      title: 'Submit canvas for human approval',
      description:
        'Submits a canvas for approval by named human approvers — the approval decision itself always happens in the Veltrix portal and cannot be made through this MCP server or with an API key. Validate the canvas first. Provide approver user IDs from veltrix_list_approvers and a comment explaining the proposed change.',
      inputSchema: submitForApprovalSchema,
      annotations: WRITE,
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
      inputSchema: canvasIdShape,
      annotations: READ,
    },
    async ({ canvasId }) => runTool(() => client.get(`/api/configuration-canvas/${canvasId}/approvals`)),
  );
}
