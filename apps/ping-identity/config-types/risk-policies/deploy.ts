import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import {
  extractRiskPolicySetSpecs,
  parseRiskPoliciesArray,
  stripReadOnlyRiskPolicySet,
  type LiveRiskPolicySet,
  type RiskPolicySetSpec,
} from './validate'

export interface RiskPolicySetRollbackEntry {
  name: string
  existed: boolean
  /** The risk policy set id PingOne assigns - the rollback key (never the name). */
  id?: string
  /** Prior set body with server-managed readOnly fields (and each riskPolicies[].priority) stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/**
 * Deploy PingOne Protect risk policy sets. NO UPSERT exists, so for each
 * declared set:
 *   - GET  /riskPolicySets           - list (paginated) and match by name
 *   - PUT  /riskPolicySets/{id}      - update an existing set (capture prior body)
 *   - POST /riskPolicySets           - create a missing set (capture the new id)
 *
 * `riskPolicies` is embedded in this SAME object - there is no child endpoint
 * for the individual rules - so this config type is authoritative for it on
 * every deploy: a blank riskPoliciesJson converges the set to zero override
 * rules rather than leaving whatever rules the environment already has.
 *
 * `defaultResult` is always sent as `{level:"LOW"}`, the only value PingOne
 * currently accepts there, so it is never read from the canvas.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractRiskPolicySetSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RiskPolicySetRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findRiskPolicySet(client, spec.name)
      const body = buildRiskPolicySetBody(spec)

      let setId: string
      if (existing && existing.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyRiskPolicySet(existing),
        })

        const res = await client.request('PUT', `/riskPolicySets/${existing.id}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to update risk policy set "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        setId = existing.id
      } else {
        const res = await client.request('POST', '/riskPolicySets', { body })
        if (!res.ok) {
          throw new Error(`Failed to create risk policy set "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LiveRiskPolicySet>(res.body)
        if (!created?.id) {
          throw new Error(`Risk policy set "${spec.name}" was created but the API returned no id`)
        }
        setId = created.id
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} risk policy set(s) to PingOne environment ${environmentId}: ${deployed.join(', ')}`,
      artifacts: { environmentId, deployedRiskPolicySets: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Risk policy set deployment failed after ${deployed.length} of ${specs.length} set(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedRiskPolicySets: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a risk policy set by exact name across the paginated list; null when absent. */
export async function findRiskPolicySet(client: PingOneClient, name: string): Promise<LiveRiskPolicySet | null> {
  const res = await client.getAll<LiveRiskPolicySet>('/riskPolicySets', 'riskPolicySets')
  if (!res.ok) {
    throw new Error(
      `Failed to list risk policy sets while resolving "${name}": ${pingOneErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
      })}`,
    )
  }
  return res.items.find((s) => s.name === name) ?? null
}

/** Fetch a single risk policy set by id; null on 404. */
export async function getRiskPolicySetById(client: PingOneClient, id: string): Promise<LiveRiskPolicySet | null> {
  const res = await client.request('GET', `/riskPolicySets/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch risk policy set ${id}: ${pingOneErrorMessage(res)}`)
  }
  return parseJson<LiveRiskPolicySet>(res.body)
}

/** Re-parse the riskPolicies JSON blob for the API body (validated upstream); throws rather than send malformed content. */
function resolveRiskPolicies(spec: RiskPolicySetSpec): Record<string, unknown>[] {
  if (!spec.riskPoliciesJson) return []
  const parsed = parseRiskPoliciesArray(spec.riskPoliciesJson)
  if (!parsed) {
    throw new Error(`Risk policy set "${spec.name}": riskPolicies is not a valid JSON array`)
  }
  return parsed as Record<string, unknown>[]
}

/**
 * Assemble the create/replace body (PUT is a full replace of the whole set).
 * `evaluatedPredictors` is omitted (not sent as an empty array) when no
 * predictor is selected, so PingOne evaluates every licensed predictor -
 * matching the canvas helpText for an empty selection.
 */
export function buildRiskPolicySetBody(spec: RiskPolicySetSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    default: spec.default,
    // The only value PingOne currently accepts here - never read from the canvas.
    defaultResult: { level: 'LOW' },
  }
  if (spec.description) body.description = spec.description
  if (spec.evaluatedPredictorIds.length > 0) {
    body.evaluatedPredictors = spec.evaluatedPredictorIds.map((id) => ({ id }))
  }
  body.riskPolicies = resolveRiskPolicies(spec)
  return body
}
