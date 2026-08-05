import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractRecastRuleSpecs, parseFilterObject, type LiveRecastRule, type RecastRuleSpec } from './validate'

export interface RecastRollbackEntry {
  /** Canvas name of the rule — also the live rule_name this deploy matches on. */
  name: string
  existed: boolean
  ruleId?: string
  prior?: {
    rule_name?: string
    description?: string
    resource_type?: string
    rule_value?: LiveRecastRule['rule_value']
    filter?: Record<string, unknown> | null
    expires_at?: string | null
    disabled_details?: LiveRecastRule['disabled_details']
  }
}

/**
 * Deploy recast/accept rules to a Tenable tenant via the Recast Rules API
 * (developer.tenable.com/reference/recast-rules-create /
 * recast-rules-update / recast-rules-search / recast-rules-details /
 * recast-rules-delete).
 *
 * There is no plain GET list — rules are found via POST
 * /v1/recast/rules/search, matched by `rule_name` (this config type sends the
 * canvas name as `rule_name`, so it doubles as the live identity, same as
 * every other named config type in this app). For each declared rule:
 *   - POST /v1/recast/rules/search  — list, then match on rule_name
 *   - PUT  /v1/recast/rules/{id}    — update a matched rule (capture prior body)
 *   - POST /v1/recast/rules         — create a missing rule (capture new rule_id)
 *
 * The full desired body (`rule_name`, `description`, `resource_type`,
 * `rule_value`, `filter`, `expires_at`, `disabled_details`) is sent on both
 * create and update — Tenable's PUT is a full replace, not a partial merge.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRecastRuleSpecs(ctx.canvas).filter(
    (s) => s.name && s.resourceType && s.action && s.filterJson,
  )
  const rollbackState: RecastRollbackEntry[] = []
  const createdRuleIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.name

      // filterJson is validated upstream; re-parse here to fail loudly rather
      // than send a malformed filter.
      const filter = parseFilterObject(spec.filterJson)
      if (filter === null) {
        throw new Error(`Rule "${label}": filter is not a valid JSON object`)
      }

      const existing = await findRecastRule(client, spec.name)

      if (existing && existing.rule_id) {
        rollbackState.push({
          name: label,
          existed: true,
          ruleId: existing.rule_id,
          prior: {
            rule_name: existing.rule_name,
            description: existing.description,
            resource_type: existing.resource_type,
            rule_value: existing.rule_value ?? null,
            filter: existing.filter ?? null,
            // Capture explicit nulls so rollback can clear values the
            // deployment sets on a rule that previously had none.
            expires_at: existing.expires_at ?? null,
            disabled_details: existing.disabled_details ?? null,
          },
        })

        const res = await client.request('PUT', `/v1/recast/rules/${existing.rule_id}`, {
          body: buildRulePayload(spec, filter),
        })
        if (!res.ok) {
          throw new Error(`Failed to update rule "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/v1/recast/rules', {
          body: buildRulePayload(spec, filter),
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
 * Find a recast rule by its rule_name; null when absent. There is no plain
 * GET list — POST /v1/recast/rules/search returns `{ rules: [...] }` for all
 * rules matching the (optional) request filters; an empty body lists every
 * rule in the tenant.
 */
export async function findRecastRule(client: TenableClient, name: string): Promise<LiveRecastRule | null> {
  const res = await client.request('POST', '/v1/recast/rules/search', { body: {} })
  if (!res.ok) {
    throw new Error(`Failed to search recast rules while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const rules = parseJson<{ rules?: LiveRecastRule[] }>(res.body)?.rules ?? []
  return rules.find((r) => r.rule_name === name) ?? null
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

/**
 * Build the rule_value object: action always; severity ONLY for RECAST;
 * compliance_result ONLY for CHANGE_RESULT; comment/false_positive whenever set.
 */
export function buildRuleValue(spec: RecastRuleSpec): Record<string, unknown> {
  const ruleValue: Record<string, unknown> = { action: spec.action }
  if (spec.action === 'RECAST' && spec.severity) ruleValue.severity = spec.severity
  if (spec.action === 'CHANGE_RESULT' && spec.complianceResult) ruleValue.compliance_result = spec.complianceResult
  if (spec.comment) ruleValue.comment = spec.comment
  if (spec.falsePositive !== undefined) ruleValue.false_positive = spec.falsePositive
  return ruleValue
}

/**
 * Build the full create/update body: `{ rule_name, description?, resource_type,
 * rule_value, filter, expires_at?, disabled_details? }`. Sent in full on both
 * create and update, since Tenable's PUT replaces rather than merges.
 */
export function buildRulePayload(
  spec: RecastRuleSpec,
  filter: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    rule_name: spec.name,
    resource_type: spec.resourceType,
    rule_value: buildRuleValue(spec),
    filter,
  }
  if (spec.description !== undefined) payload.description = spec.description
  if (spec.expiresAt) payload.expires_at = spec.expiresAt
  if (spec.disabled !== undefined) {
    payload.disabled_details = {
      disabled: spec.disabled,
      ...(spec.disabledReason ? { disabled_reason: spec.disabledReason } : {}),
    }
  }
  return payload
}
