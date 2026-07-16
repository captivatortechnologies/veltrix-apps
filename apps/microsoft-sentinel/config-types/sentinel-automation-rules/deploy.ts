import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SENTINEL_API_VERSION,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import { extractAutomationSpecs, type AutomationRuleSpec } from './validate'

/** State captured per rule so a rollback can delete creates and restore updates. */
export interface AutomationRollbackEntry {
  ruleName: string
  ruleId: string
  existed: boolean
  prior?: { etag?: string; properties?: unknown }
}

/** The Microsoft.SecurityInsights AutomationRule request body for a spec. */
export function buildAutomationRuleBody(spec: AutomationRuleSpec): unknown {
  const actionConfiguration: Record<string, string> = {}
  if (spec.setSeverity) actionConfiguration.severity = spec.setSeverity
  if (spec.setStatus) actionConfiguration.status = spec.setStatus

  return {
    properties: {
      displayName: spec.ruleName,
      order: spec.order,
      triggeringLogic: {
        isEnabled: spec.enabled,
        triggersOn: spec.triggersOn,
        triggersWhen: spec.triggersWhen,
        conditions: [],
      },
      actions: [
        {
          order: 1,
          actionType: 'ModifyProperties',
          actionConfiguration,
        },
      ],
    },
  }
}

/** GET one automation rule by its ARM automationRuleId. */
export function getAutomationRule(client: SentinelClient, ruleId: string): Promise<SentinelResponse> {
  return client.request('GET', client.sentinelPath(`/automationRules/${ruleId}`), { apiVersion: SENTINEL_API_VERSION })
}

/**
 * Deploy automation rules via ARM. Reconciliation is by the rule's deterministic
 * ARM automationRuleId (slug of the name): GET to learn whether it exists (and
 * capture prior state for rollback), then PUT (upsert). Rules not declared here
 * are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractAutomationSpecs(ctx.canvas).filter((s) => s.ruleName)
  const rollbackState: AutomationRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const current = await getAutomationRule(client, spec.ruleId)
      let existed = false
      if (current.status === 200) {
        existed = true
        const prior = parseJson<{ etag?: string; properties?: unknown }>(current.body)
        rollbackState.push({ ruleName: spec.ruleName, ruleId: spec.ruleId, existed: true, prior: { etag: prior?.etag, properties: prior?.properties } })
      } else if (current.status === 404) {
        rollbackState.push({ ruleName: spec.ruleName, ruleId: spec.ruleId, existed: false })
      } else {
        throw new Error(`Failed to read automation rule "${spec.ruleName}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', client.sentinelPath(`/automationRules/${spec.ruleId}`), {
        apiVersion: SENTINEL_API_VERSION,
        body: buildAutomationRuleBody(spec),
      })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} automation rule "${spec.ruleName}": ${armErrorMessage(res)}`)
      ;(existed ? updated : created).push(spec.ruleName)
    }

    return {
      success: true,
      message: `Automation rules deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Automation rule deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
