import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

interface PromptConfig {
  title: string;
  description: string;
  argsSchema?: ZodRawShape;
}

type PromptHandler = (args: Record<string, string | undefined>) => GetPromptResult;

const userMessage = (text: string): GetPromptResult => ({
  messages: [{ role: 'user', content: { type: 'text', text } }],
});

const proposeChangeArgs: ZodRawShape = {
  change: z.string().describe('What should change, in plain language'),
  app: z.string().optional().describe('App slug, e.g. "splunk-enterprise", if known'),
};

const triageDriftArgs: ZodRawShape = {
  environment: z.string().optional().describe('Environment name to focus on, e.g. "production"'),
};

const deploymentReportArgs: ZodRawShape = {
  canvas: z.string().optional().describe('Canvas name or id to report on; omit for the whole tenant'),
};

export function registerPrompts(server: McpServer): void {
  // Same generic erasure as toolRegistrar (TS2589 on the SDK's zod generics).
  const register = server.registerPrompt.bind(server) as unknown as (
    name: string,
    config: PromptConfig,
    handler: PromptHandler,
  ) => void;

  register(
    'veltrix_propose_change',
    {
      title: 'Propose a configuration change',
      description: 'Draft, validate and submit a security-tool configuration change for human approval.',
      argsSchema: proposeChangeArgs,
    },
    ({ change, app }) =>
      userMessage(
        [
          `Propose this configuration change in Veltrix: ${change}`,
          app ? `Target app: ${app}.` : 'Work out the target app with veltrix_list_apps (enabledOnly) and confirm it with me if it is ambiguous.',
          '',
          'Follow the governed pipeline:',
          '1. veltrix_whoami — confirm the key is valid and which tenant this is.',
          '2. veltrix_list_canvases — check whether a canvas for this configuration already exists. If one is deployed or approved, duplicate it rather than editing it.',
          '3. veltrix_get_app and veltrix_get_config_type_schema — use the real field schema; do not invent fields.',
          '4. veltrix_create_canvas or veltrix_update_canvas, then veltrix_validate_canvas. Fix every error and tell me about warnings.',
          '5. Show me a summary of exactly what will change and ask who should approve (veltrix_list_approvers). Do not pick approvers for me.',
          '6. veltrix_submit_canvas_for_approval with a comment explaining what changed and why.',
          '',
          'Stop there. Approval is a human decision made in the Veltrix portal; do not deploy until veltrix_get_canvas_approvals shows it approved and I ask you to.',
        ].join('\n'),
      ),
  );

  register(
    'veltrix_triage_drift',
    {
      title: 'Triage configuration drift',
      description: 'Review unresolved drift, explain what changed out-of-band and recommend what to do about each item.',
      argsSchema: triageDriftArgs,
    },
    ({ environment }) =>
      userMessage(
        [
          `Triage unresolved configuration drift${environment ? ` in the ${environment} environment` : ''}.`,
          '',
          '1. veltrix_list_drift with isResolved=false' +
            (environment ? ' (resolve the environment id with veltrix_list_environments).' : '.'),
          '2. For each record, most severe first, use veltrix_get_canvas_drift and veltrix_get_canvas to explain in plain language what differs between the deployed configuration and the live state.',
          '3. For each, recommend one of: redeploy the approved configuration, propose a change that adopts the live state, or accept the drift — and say why.',
          '',
          'Report findings as a table (configuration, environment, severity, what changed, recommendation). Do not resolve, acknowledge, redeploy or edit anything until I choose.',
        ].join('\n'),
      ),
  );

  register(
    'veltrix_deployment_report',
    {
      title: 'Deployment status report',
      description: 'Summarize what is deployed where, what is in flight, and what needs attention.',
      argsSchema: deploymentReportArgs,
    },
    ({ canvas }) =>
      userMessage(
        canvas
          ? [
              `Report on the deployment status of the Veltrix configuration "${canvas}".`,
              '',
              'Find it with veltrix_list_canvases if I gave a name, then use veltrix_get_pipeline_status, veltrix_list_canvas_deployments and veltrix_get_canvas_approvals.',
              'Tell me: its current status, which version is in which environment, the health of the latest deployment, any pending approvals or unresolved drift, and the next step in the pipeline.',
            ].join('\n')
          : [
              'Give me a deployment status report for this Veltrix tenant.',
              '',
              'Use veltrix_pipeline_summary and veltrix_environment_matrix, then look closer at anything failed, paused or waiting.',
              'Lead with what needs attention (failed deployments, changes waiting on approval, unresolved drift), then summarize what is deployed in each environment. Keep it short; this is read-only.',
            ].join('\n'),
      ),
  );
}
