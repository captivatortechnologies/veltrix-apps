import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SENTINEL_API_VERSION,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import { extractMsSecuritySpecs, type MsSecurityRuleSpec } from './validate'

/** The single alertRule kind this config type manages (GA on SENTINEL_API_VERSION). */
export const MS_SECURITY_KIND = 'MicrosoftSecurityIncidentCreation'

/** State captured per rule so a rollback can delete creates and restore updates. */
export interface MsSecurityRollbackEntry {
  ruleName: string
  ruleId: string
  existed: boolean
  prior?: { kind?: string; properties?: unknown }
}

/**
 * The Microsoft.SecurityInsights MicrosoftSecurityIncidentCreationAlertRule request
 * body for a spec. The optional filters and description are omitted when empty so a
 * "match everything" rule is never pinned to an empty array.
 */
export function buildMsSecurityRuleBody(spec: MsSecurityRuleSpec): unknown {
  const properties: Record<string, unknown> = {
    displayName: spec.ruleName,
    enabled: spec.enabled,
    productFilter: spec.productFilter,
  }
  if (spec.description) properties.description = spec.description
  if (spec.displayNamesFilter.length > 0) properties.displayNamesFilter = spec.displayNamesFilter
  if (spec.displayNamesExcludeFilter.length > 0) properties.displayNamesExcludeFilter = spec.displayNamesExcludeFilter
  if (spec.severitiesFilter.length > 0) properties.severitiesFilter = spec.severitiesFilter
  return { kind: MS_SECURITY_KIND, properties }
}

/** GET one alert rule by its ARM ruleId. */
export function getMsSecurityRule(client: SentinelClient, ruleId: string): Promise<SentinelResponse> {
  return client.request('GET', client.sentinelPath(`/alertRules/${ruleId}`), { apiVersion: SENTINEL_API_VERSION })
}

/**
 * Deploy Microsoft Security rules via ARM. Reconciliation is by the rule's
 * deterministic ARM ruleId (slug of the name): GET to learn whether it exists (and
 * capture prior state for rollback), then PUT (upsert). Rules not declared here are
 * left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractMsSecuritySpecs(ctx.canvas).filter((s) => s.ruleName)
  const rollbackState: MsSecurityRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const current = await getMsSecurityRule(client, spec.ruleId)
      let existed = false
      if (current.status === 200) {
        existed = true
        const prior = parseJson<{ kind?: string; properties?: unknown }>(current.body)
        rollbackState.push({
          ruleName: spec.ruleName,
          ruleId: spec.ruleId,
          existed: true,
          prior: { kind: prior?.kind, properties: prior?.properties },
        })
      } else if (current.status === 404) {
        rollbackState.push({ ruleName: spec.ruleName, ruleId: spec.ruleId, existed: false })
      } else {
        throw new Error(`Failed to read Microsoft Security rule "${spec.ruleName}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', client.sentinelPath(`/alertRules/${spec.ruleId}`), {
        apiVersion: SENTINEL_API_VERSION,
        body: buildMsSecurityRuleBody(spec),
      })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} Microsoft Security rule "${spec.ruleName}": ${armErrorMessage(res)}`)
      ;(existed ? updated : created).push(spec.ruleName)
    }

    return {
      success: true,
      message: `Microsoft Security rules deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Microsoft Security rule deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
