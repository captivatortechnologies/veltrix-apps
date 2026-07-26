import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SENTINEL_API_VERSION,
  SENTINEL_NRT_API_VERSION,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import { extractRuleSpecs, isNrt, type ScheduledRuleSpec } from './validate'

/** State captured per rule so a rollback can delete creates and restore updates. */
export interface AnalyticsRollbackEntry {
  ruleName: string
  ruleId: string
  existed: boolean
  /** The kind this deploy wrote — selects the api-version for a create-delete rollback. */
  deployedKind: string
  prior?: { kind?: string; properties?: unknown }
}

/**
 * The api-version for an alertRule of a given kind. Scheduled is GA; NRT is only
 * defined on the preview contract, so NRT reads/writes use the preview version.
 */
export function alertRuleApiVersion(kind: string): string {
  return isNrt(kind) ? SENTINEL_NRT_API_VERSION : SENTINEL_API_VERSION
}

/** The Microsoft.SecurityInsights ScheduledAlertRule request body for a spec. */
export function buildScheduledRuleBody(spec: ScheduledRuleSpec): unknown {
  return {
    kind: 'Scheduled',
    properties: {
      displayName: spec.ruleName,
      enabled: spec.enabled,
      query: spec.query,
      queryFrequency: spec.queryFrequency,
      queryPeriod: spec.queryPeriod,
      severity: spec.severity,
      triggerOperator: spec.triggerOperator,
      triggerThreshold: spec.triggerThreshold,
      suppressionDuration: spec.suppressionDuration,
      suppressionEnabled: spec.suppressionEnabled,
      tactics: spec.tactics,
    },
  }
}

/**
 * The Microsoft.SecurityInsights NrtAlertRule request body for a spec. NRT rules
 * run continuously against incoming events, so they carry NO queryFrequency,
 * queryPeriod, triggerOperator or triggerThreshold.
 */
export function buildNrtRuleBody(spec: ScheduledRuleSpec): unknown {
  return {
    kind: 'NRT',
    properties: {
      displayName: spec.ruleName,
      enabled: spec.enabled,
      query: spec.query,
      severity: spec.severity,
      suppressionDuration: spec.suppressionDuration,
      suppressionEnabled: spec.suppressionEnabled,
      tactics: spec.tactics,
    },
  }
}

/** Build the request body for a rule, dispatching on its kind (Scheduled | NRT). */
export function buildAlertRuleBody(spec: ScheduledRuleSpec): unknown {
  return isNrt(spec.kind) ? buildNrtRuleBody(spec) : buildScheduledRuleBody(spec)
}

/** GET one alert rule by its ARM ruleId, using the api-version for its kind. */
export function getAlertRule(client: SentinelClient, ruleId: string, kind = 'Scheduled'): Promise<SentinelResponse> {
  return client.request('GET', client.sentinelPath(`/alertRules/${ruleId}`), { apiVersion: alertRuleApiVersion(kind) })
}

/**
 * Deploy analytics rules (Scheduled + NRT) via ARM. Reconciliation is by the
 * rule's deterministic ARM ruleId (slug of the name): GET the rule to learn
 * whether it exists (and capture prior state for rollback), then PUT (upsert).
 * Scheduled rules use the GA api-version; NRT rules use the preview api-version
 * that declares kind:NRT. Rules not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.ruleName)
  const rollbackState: AnalyticsRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const apiVersion = alertRuleApiVersion(spec.kind)
      const current = await getAlertRule(client, spec.ruleId, spec.kind)
      let existed = false
      if (current.status === 200) {
        existed = true
        const prior = parseJson<{ kind?: string; properties?: unknown }>(current.body)
        rollbackState.push({
          ruleName: spec.ruleName,
          ruleId: spec.ruleId,
          existed: true,
          deployedKind: spec.kind,
          prior: { kind: prior?.kind, properties: prior?.properties },
        })
      } else if (current.status === 404) {
        rollbackState.push({ ruleName: spec.ruleName, ruleId: spec.ruleId, existed: false, deployedKind: spec.kind })
      } else {
        throw new Error(`Failed to read analytics rule "${spec.ruleName}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', client.sentinelPath(`/alertRules/${spec.ruleId}`), {
        apiVersion,
        body: buildAlertRuleBody(spec),
      })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} analytics rule "${spec.ruleName}": ${armErrorMessage(res)}`)
      ;(existed ? updated : created).push(spec.ruleName)
    }

    return {
      success: true,
      message: `Analytics rules deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Analytics rule deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
