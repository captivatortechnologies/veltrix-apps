import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import {
  buildRecastFilter,
  extractRecastRuleSpecs,
  parseFilterObject,
  type LiveRecastRule,
  type RecastRuleSpec,
} from './validate'

export interface RecastRollbackEntry {
  /** Canvas name of the rule (for reporting only — not a live identity). */
  name: string
  existed: boolean
  ruleId?: string
  prior?: {
    resource_type?: string
    rule_value?: { action?: string; severity?: string } | null
    filter?: Record<string, unknown> | null
    expires_at?: string | null
  }
}

/**
 * Deploy recast/accept rules to a Tenable tenant via the Recast Rules API.
 *
 * A recast rule has no natural name, so live rules are matched by the
 * (resource_type, pluginId, action) tuple — the same tuple validate dedupes on.
 * For each declared rule:
 *   - GET  /v1/recast/rules          — list, then match on the tuple
 *   - PUT  /v1/recast/rules/{rule_id} — update a matched rule (capture prior body)
 *   - POST /v1/recast/rules          — create a missing rule (capture new rule_id)
 *
 * severity is sent inside rule_value ONLY for RECAST; an ACCEPT rule carries no
 * severity (the API forbids/ignores it).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRecastRuleSpecs(ctx.canvas).filter(
    (s) => s.name && s.resourceType && s.action && s.pluginId,
  )
  const rollbackState: RecastRollbackEntry[] = []
  const createdRuleIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.name

      // filterJson is validated upstream; re-parse here to fail loudly rather
      // than send a malformed filter, then build the merged filter body.
      if (spec.filterJson && parseFilterObject(spec.filterJson) === null) {
        throw new Error(`Rule "${label}": filter JSON is not a valid JSON object`)
      }

      const existing = await findRecastRule(client, spec)

      if (existing && existing.rule_id) {
        rollbackState.push({
          name: label,
          existed: true,
          ruleId: existing.rule_id,
          prior: {
            resource_type: existing.resource_type,
            rule_value: existing.rule_value ?? null,
            filter: existing.filter ?? null,
            // Capture an explicit null so rollback can clear an expiry the
            // deployment sets on a rule that previously had none.
            expires_at: existing.expires_at ?? null,
          },
        })

        const res = await client.request('PUT', `/v1/recast/rules/${existing.rule_id}`, {
          body: buildRulePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update rule "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/v1/recast/rules', {
          body: buildRulePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create rule "${label}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveRecastRule>(res.body)
        if (!created?.rule_id) {
          throw new Error(`Rule "${label}" was created but the API returned no rule_id`)
        }
        rollbackState.push({ name: label, existed: false, ruleId: created.rule_id })
        createdRuleIds.push(created.rule_id)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} recast rule(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Recast rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  }
}

// --- Helpers ---

/**
 * Find a recast rule by its (resource_type, pluginId, action) tuple; null when
 * absent. GET /v1/recast/rules returns the full rule list.
 */
export async function findRecastRule(
  client: TenableClient,
  spec: RecastRuleSpec,
): Promise<LiveRecastRule | null> {
  const res = await client.request('GET', '/v1/recast/rules')
  if (!res.ok) {
    throw new Error(`Failed to list recast rules while resolving "${spec.name}": ${tenableErrorMessage(res)}`)
  }
  const rules = parseJson<{ rules?: LiveRecastRule[] }>(res.body)?.rules ?? []
  return rules.find((r) => ruleMatches(r, spec)) ?? null
}

/** Fetch a single recast rule by rule_id; null on 404. */
export async function getRecastRuleById(
  client: TenableClient,
  ruleId: string,
): Promise<LiveRecastRule | null> {
  const res = await client.request('GET', `/v1/recast/rules/${ruleId}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch recast rule ${ruleId}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LiveRecastRule>(res.body)
}

/** The tuple match: same resource type, same action, same plugin id. */
export function ruleMatches(live: LiveRecastRule, spec: RecastRuleSpec): boolean {
  return (
    live.resource_type === spec.resourceType &&
    (live.rule_value?.action ?? '') === spec.action &&
    livePluginId(live) === spec.pluginId
  )
}

/** Read filter.plugin_id off a live rule as a string (it may be numeric). */
export function livePluginId(live: LiveRecastRule): string {
  const value = live.filter?.plugin_id
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

/** Build the create/update body. severity is included only for a RECAST rule. */
function buildRulePayload(spec: RecastRuleSpec): Record<string, unknown> {
  const ruleValue: Record<string, unknown> = { action: spec.action }
  // severity is the recast target — meaningful (and permitted) only for RECAST.
  if (spec.action === 'RECAST' && spec.severity) ruleValue.severity = spec.severity

  const payload: Record<string, unknown> = {
    resource_type: spec.resourceType,
    rule_value: ruleValue,
    filter: buildRecastFilter(spec),
  }
  if (spec.expiresAt) payload.expires_at = spec.expiresAt
  return payload
}
