import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  canonicalJson,
  extractIdpRuleSpecs,
  parseConditions,
  type IdpRuleSpec,
  type LiveIdpRule,
} from './validate'

// =============================================================================
// Deploy Falcon Identity Protection policy rules.
//
// ────────────────────────────  REPLACE-IN-PLACE  ────────────────────────────
// The Falcon Identity Protection API has NO update/PATCH endpoint for policy
// rules — only create (POST), get/query (GET), and delete (DELETE). (Verified
// against FalconPy's identity_protection service, which exposes exactly
// get_policy_rules / query_policy_rules / create_policy_rule /
// delete_policy_rules and no update.)
//
// Therefore a rule whose managed fields have changed CANNOT be edited in place.
// This handler converges it by DELETING the old rule and CREATING a new one.
// Consequences the reader must know:
//   - The rule's underlying id is NOT preserved across a change. `name` is the
//     stable identity; ids churn on every replace.
//   - There is a brief window between delete and create where the rule does not
//     exist. If the create fails, the old rule is already gone — deploy returns
//     failure with rollback data that recreates the prior rule.
//   - Rollback likewise replaces-in-place (see rollback.ts): delete what we
//     created, recreate what was there before (again under a fresh id).
//
// Endpoints:
//   query  GET    /identity-protection/queries/policy-rules/v1?name=…
//   get    GET    /identity-protection/entities/policy-rules/v1?ids=…
//   create POST   /identity-protection/entities/policy-rules/v1
//   delete DELETE /identity-protection/entities/policy-rules/v1?ids=…
// =============================================================================

/** Condition fields the API accepts on a rule, alongside name/enabled/simulationMode/action. */
export const CONDITION_KEYS = ['activity', 'sourceUser', 'sourceEndpoint', 'destination', 'trigger'] as const

/** State captured per rule so rollback can replace-in-place back to the prior state. */
export interface IdpRuleRollbackEntry {
  name: string
  /** A rule with this name existed before the deploy. */
  existed: boolean
  /** Deploy intended a delete+recreate for this rule (managed fields changed). */
  replaced: boolean
  /** The prior rule was actually deleted — only then is recreating it on rollback safe. */
  deleted?: boolean
  /** Recreatable body of the rule that existed before this deploy. */
  priorRule?: Record<string, unknown>
  /** Id of the prior rule (deleted during replace) — informational; not restorable. */
  priorId?: string
  /** Id of the rule this deploy created (the current live rule). */
  createdId?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  // Lower precedence deploys first; rules without a precedence hint keep their
  // declared order after those that have one. The REST API has no precedence
  // field — creation order is the only lever we have over rule ordering.
  const specs = extractIdpRuleSpecs(ctx.canvas)
    .filter((s) => s.name)
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) => precedenceRank(a.spec) - precedenceRank(b.spec) || a.index - b.index)
    .map((e) => e.spec)

  const rollbackState: IdpRuleRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { conditions, errors: conditionErrors } = parseConditions(spec.conditionsRaw)
      if (conditionErrors.length > 0) {
        throw new Error(`Rule "${spec.name}": invalid conditions — ${conditionErrors[0]}`)
      }

      const desired = buildRuleBody(spec, conditions)
      const existing = await findRuleByName(client, spec.name)

      if (existing?.id) {
        if (ruleMatchesDesired(existing, spec, conditions)) {
          // Nothing changed — leave the live rule untouched (no destructive
          // replace) and record a no-op so rollback skips it.
          rollbackState.push({ name: spec.name, existed: true, replaced: false })
        } else {
          // REPLACE-IN-PLACE: capture the prior rule BEFORE deleting so a
          // failure mid-replace still leaves rollback able to recreate it.
          const entry: IdpRuleRollbackEntry = {
            name: spec.name,
            existed: true,
            replaced: true,
            priorRule: toCreateBody(existing),
            priorId: existing.id,
          }
          rollbackState.push(entry)

          await deleteRule(client, existing.id)
          entry.deleted = true

          entry.createdId = await createRule(client, spec.name, desired)
        }
      } else {
        const createdId = await createRule(client, spec.name, desired)
        rollbackState.push({ name: spec.name, existed: false, replaced: false, createdId })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Identity Protection policy rule(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity Protection policy rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied,
      // including recreating a prior rule that was deleted mid-replace.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

function precedenceRank(spec: IdpRuleSpec): number {
  return spec.precedence ?? Number.MAX_SAFE_INTEGER
}

/** The create body for a declared rule: managed fields plus the condition tree. */
export function buildRuleBody(spec: IdpRuleSpec, conditions: Record<string, unknown>): Record<string, unknown> {
  return {
    name: spec.name,
    enabled: spec.enabled,
    simulationMode: spec.simulationMode,
    action: spec.action,
    ...conditions,
  }
}

/** Strip a live rule down to a recreatable create body (drops id and audit metadata). */
export function toCreateBody(live: LiveIdpRule): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: live.name,
    enabled: live.enabled ?? false,
    simulationMode: live.simulationMode ?? false,
    action: live.action,
  }
  for (const key of CONDITION_KEYS) {
    const value = (live as Record<string, unknown>)[key]
    if (value !== undefined) body[key] = value
  }
  return body
}

/**
 * True when the live rule already matches the declared managed fields — the
 * managed scalars plus every condition key the canvas declares. Extra live
 * keys are not considered (only what the canvas manages), which avoids a
 * needless destructive replace over server-added defaults.
 */
export function ruleMatchesDesired(
  live: LiveIdpRule,
  spec: IdpRuleSpec,
  conditions: Record<string, unknown>,
): boolean {
  if ((live.enabled ?? false) !== spec.enabled) return false
  if ((live.simulationMode ?? false) !== spec.simulationMode) return false
  if ((live.action ?? '').toUpperCase() !== spec.action) return false
  for (const [key, value] of Object.entries(conditions)) {
    if (canonicalJson((live as Record<string, unknown>)[key]) !== canonicalJson(value)) return false
  }
  return true
}

/** Look up a rule by exact name; null when absent. Pins the exact name client-side. */
export async function findRuleByName(client: FalconClient, name: string): Promise<LiveIdpRule | null> {
  const queryRes = await client.request('GET', '/identity-protection/queries/policy-rules/v1', {
    query: { name },
  })
  if (!queryRes.ok) {
    throw new Error(`Failed to search rule "${name}": ${falconErrorMessage(queryRes)}`)
  }

  const ids = (parseEnvelope<string>(queryRes.body)?.resources ?? []).filter(
    (id): id is string => typeof id === 'string',
  )
  if (ids.length === 0) return null

  // FalconClient's query serializer can't repeat ids=, so encode the id list
  // into the path (the entityAdapter uses the same technique).
  const idsPath = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')
  const detailRes = await client.request('GET', `/identity-protection/entities/policy-rules/v1?${idsPath}`)
  if (!detailRes.ok) {
    throw new Error(`Failed to read rule "${name}": ${falconErrorMessage(detailRes)}`)
  }

  const rules = parseEnvelope<LiveIdpRule>(detailRes.body)?.resources ?? []
  const exact = rules.find((r) => r.name === name)
  if (exact) return exact
  // Tolerate a single unambiguous case-insensitive match; never adopt an
  // arbitrary one, which would replace a rule the canvas never declared.
  const caseInsensitive = rules.filter((r) => (r.name ?? '').toLowerCase() === name.toLowerCase())
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Create a rule and return its new id (or throw). */
export async function createRule(
  client: FalconClient,
  name: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await client.request('POST', '/identity-protection/entities/policy-rules/v1', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create rule "${name}": ${failure}`)
  }
  const created = parseEnvelope<LiveIdpRule>(res.body)?.resources?.[0]
  if (!created?.id) {
    throw new Error(`Rule "${name}" was created but the API returned no rule id`)
  }
  return created.id
}

/** Delete a rule by id; a 404 means it is already gone (the desired outcome). */
export async function deleteRule(client: FalconClient, id: string): Promise<void> {
  const res = await client.request('DELETE', '/identity-protection/entities/policy-rules/v1', {
    query: { ids: id },
  })
  const failure = res.status === 404 ? null : falconFailure(res)
  if (failure) {
    throw new Error(`Failed to delete rule (${id}): ${failure}`)
  }
}
