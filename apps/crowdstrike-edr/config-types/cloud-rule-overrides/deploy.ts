import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
  type FalconMethod,
} from '../../lib/falcon'
import type { EntityEndpoints } from '../../lib/entityAdapter'
import { extractOverrideSpecs, type LiveRuleOverride, type OverrideSpec } from './validate'

/**
 * Paths for the Cloud Security Rule Overrides API surface.
 *
 * `identityField` is `rule_id`: an override targets a built-in rule (optionally
 * scoped by `crn`). This collection has NO working queries endpoint in the
 * Falcon API — the generic entityAdapter find-by-query cannot be used — so
 * existing overrides are read by id via GET <entity>?ids=<rule_id> (see
 * findOverride). The `queries` path is recorded for completeness only.
 */
export const OVERRIDE_ENDPOINTS: EntityEndpoints = {
  entity: '/cloud-policies/entities/rule-overrides/v1',
  queries: '/cloud-policies/queries/rule-overrides/v1',
  identityField: 'rule_id',
}

export const DEPLOY_COMMENT = 'Managed by Veltrix (crowdstrike-edr app)'

/** Managed fields captured for rollback. */
export interface OverrideRollbackEntry {
  ruleId: string
  crn?: string
  existed: boolean
  id?: string
  prior?: {
    override_type?: string
    overrides_details?: string
    reason?: string
    comment?: string
    target_region?: string
    expires_at?: string
  }
}

/**
 * Deploy rule overrides to a Falcon tenant via the Cloud Security API.
 *
 * For each declared override:
 *   - read the current override for its rule id (GET <entity>?ids=<rule_id>)
 *   - if one exists, PATCH it back with the managed fields
 *   - otherwise POST a new override
 *
 * The write body is wrapped as { overrides: [ {...} ] }. Prior state is captured
 * so rollback can revert updates and delete anything this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractOverrideSpecs(ctx.canvas).filter((s) => s.ruleId)
  const rollbackState: OverrideRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findOverride(client, spec.ruleId, spec.crn)

      if (existing) {
        rollbackState.push({
          ruleId: spec.ruleId,
          crn: spec.crn,
          existed: true,
          id: existing.id,
          prior: {
            override_type: existing.override_type,
            overrides_details: existing.overrides_details,
            reason: existing.reason,
            comment: typeof existing.comment === 'string' ? existing.comment : undefined,
            target_region: existing.target_region,
            expires_at: existing.expires_at,
          },
        })
        await writeOverride(client, 'PATCH', buildOverrideEntry(spec))
      } else {
        const id = await writeOverride(client, 'POST', buildOverrideEntry(spec))
        rollbackState.push({ ruleId: spec.ruleId, crn: spec.crn, existed: false, id })
      }

      deployed.push(spec.ruleId)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} rule override(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRuleOverrides: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Rule override deployment failed after ${deployed.length} of ${specs.length} override(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRuleOverrides: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Read the current override for a rule id (optionally pinned to a `crn` scope).
 * Returns null when none exists. This collection has no queries endpoint, so the
 * override is fetched directly by id — the override is addressed by its rule id.
 */
export async function findOverride(
  client: FalconClient,
  ruleId: string,
  crn?: string,
): Promise<LiveRuleOverride | null> {
  const res = await client.request('GET', OVERRIDE_ENDPOINTS.entity, { query: { ids: ruleId } })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read override for rule "${ruleId}": ${falconErrorMessage(res)}`)
  }
  const resources = parseEnvelope<LiveRuleOverride>(res.body)?.resources ?? []
  const match = resources.find(
    (r) =>
      r != null &&
      typeof r === 'object' &&
      (r.rule_id === ruleId || r.id === ruleId) &&
      (!crn || r.crn === crn),
  )
  return match ?? null
}

/** Send the wrapped { overrides: [entry] } write; returns a created id if the API supplies one. */
export async function writeOverride(
  client: FalconClient,
  method: FalconMethod,
  entry: Record<string, unknown>,
): Promise<string | undefined> {
  const res = await client.request(method, OVERRIDE_ENDPOINTS.entity, { body: { overrides: [entry] } })
  const failure = falconFailure(res)
  if (failure) {
    const verb = method === 'POST' ? 'create' : 'update'
    throw new Error(`Failed to ${verb} override for rule "${String(entry.rule_id)}": ${failure}`)
  }
  return parseEnvelope<LiveRuleOverride>(res.body)?.resources?.[0]?.id
}

/** The single override object this app writes, as the API expects it. */
export function buildOverrideEntry(spec: OverrideSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    rule_id: spec.ruleId,
    override_type: spec.overrideType,
    comment: spec.comment ?? DEPLOY_COMMENT,
  }
  if (spec.overrideDetails) entry.overrides_details = spec.overrideDetails
  if (spec.reason) entry.reason = spec.reason
  if (spec.crn) entry.crn = spec.crn
  if (spec.targetRegion) entry.target_region = spec.targetRegion
  if (spec.expiresAt) entry.expires_at = spec.expiresAt
  return entry
}
