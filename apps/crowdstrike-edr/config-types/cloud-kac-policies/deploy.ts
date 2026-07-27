import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconResponse,
  type FalconClient,
} from '../../lib/falcon'
import { extractKacPolicySpecs, parseRuleGroups, type LiveKacPolicy } from './validate'

/** Admission Control Policy API (Falcon Cloud Security KAC). */
export const KAC_ENTITY = '/admission-control-policies/entities/policies/v1'
export const KAC_QUERIES = '/admission-control-policies/queries/policies/v1'

export interface KacPolicyRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
  }
}

const DEPLOY_NOTE =
  'Rule groups and default action are validated and captured but not yet pushed — the Admission ' +
  'Control policy write body only accepts name/description/enabled; nested rule groups deploy ' +
  'via the separate policy-rule-groups endpoints (Phase 4).'

/**
 * Deploy Kubernetes Admission Control (KAC) policies to a Falcon tenant.
 *
 * The Admission Control Policy API is multi-step and does NOT accept the nested
 * model inline: create takes only { name, description }; enablement is a separate
 * PATCH ({ is_enabled }); host groups and rule groups have their own sub-entity
 * endpoints. Phase 3 therefore converges the SCALAR policy fields the write body
 * supports and captures the declared rule_groups / default action for drift and
 * a later rollout. For each declared policy:
 *   - GET    /admission-control-policies/queries/policies/v1?filter=name:~'…'  — find ids
 *   - GET    /admission-control-policies/entities/policies/v1?ids=…            — pin by exact name
 *   - POST   /admission-control-policies/entities/policies/v1                  — create { name, description }
 *   - PATCH  /admission-control-policies/entities/policies/v1?ids=…            — converge { name, description, is_enabled }
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractKacPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: KacPolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { errors: ruleGroupErrors } = parseRuleGroups(spec.ruleGroupsRaw)
      if (ruleGroupErrors.length > 0) {
        throw new Error(`Policy "${spec.name}": invalid rule groups — ${ruleGroupErrors[0]}`)
      }

      const existing = await findKacPolicy(client, spec.name)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empty so rollback can clear a description this
            // deployment sets on a policy that previously had none.
            description: existing.description ?? '',
            enabled: liveEnabled(existing),
          },
        })
        await updateKacPolicy(client, existing.id, spec.name, spec.description ?? '', spec.enabled)
      } else {
        const id = await createKacPolicy(client, spec.name, spec.description ?? '')
        rollbackState.push({ name: spec.name, existed: false, id })
        // Create cannot set enablement — converge it (and description) via update.
        await updateKacPolicy(client, id, spec.name, spec.description ?? '', spec.enabled)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} KAC policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed, note: DEPLOY_NOTE },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `KAC policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed, note: DEPLOY_NOTE },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Look up a KAC policy by exact name. The queries endpoint returns only ids, so
 * this pages the id query (contains match, since exact-match name filters
 * silently return empty for most custom names) then fetches the entities and
 * pins the exact name client-side; a single unambiguous case-insensitive match
 * is tolerated.
 */
export async function findKacPolicy(client: FalconClient, name: string): Promise<LiveKacPolicy | null> {
  const limit = 500
  const caseInsensitive: LiveKacPolicy[] = []

  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', KAC_QUERIES, {
      query: { filter: `name:~'${fqlEscape(name)}'`, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search KAC policy "${name}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const policies = await getKacPoliciesByIds(client, ids)
      const exact = policies.find((p) => p.name === name)
      if (exact) return exact
      caseInsensitive.push(...policies.filter((p) => p.name?.toLowerCase() === name.toLowerCase()))
    }
    if (ids.length < limit) break
  }

  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Fetch full KAC policies by id. The FalconClient query serializer can't repeat
 * `ids=`, so the id list is encoded into the path. */
export async function getKacPoliciesByIds(
  client: FalconClient,
  ids: string[],
): Promise<LiveKacPolicy[]> {
  if (ids.length === 0) return []
  const query = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')
  const res = await client.request('GET', `${KAC_ENTITY}?${query}`)
  if (!res.ok) {
    throw new Error(`Failed to load KAC policies: ${falconErrorMessage(res)}`)
  }
  return parseEnvelope<LiveKacPolicy>(res.body)?.resources ?? []
}

/** Create a KAC policy (name + description only) and return its new id. */
export async function createKacPolicy(
  client: FalconClient,
  name: string,
  description: string,
): Promise<string> {
  const res = await client.request('POST', KAC_ENTITY, { body: { name, description } })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create KAC policy "${name}": ${failure}`)
  }
  const id = parseEnvelope<LiveKacPolicy>(res.body)?.resources?.[0]?.id
  if (!id) {
    throw new Error(`KAC policy "${name}" was created but the API returned no policy id`)
  }
  return id
}

/** Converge a KAC policy's scalar fields — name, description, enablement. */
export async function updateKacPolicy(
  client: FalconClient,
  id: string,
  name: string,
  description: string,
  enabled: boolean,
): Promise<void> {
  const res = await client.request('PATCH', KAC_ENTITY, {
    query: { ids: id },
    body: { name, description, is_enabled: enabled },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update KAC policy "${name}": ${failure}`)
  }
}

/** Delete a KAC policy by id. Returns the raw response so the caller handles 404. */
export async function deleteKacPolicy(client: FalconClient, id: string): Promise<FalconResponse> {
  return client.request('DELETE', KAC_ENTITY, { query: { ids: id } })
}

/** Enablement read tolerant of the write model's `is_enabled` and read `enabled`. */
export function liveEnabled(policy: LiveKacPolicy): boolean {
  if (typeof policy.is_enabled === 'boolean') return policy.is_enabled
  if (typeof policy.enabled === 'boolean') return policy.enabled
  return false
}

/** Host group ids from either a string[] or an object list on a live policy. */
export function liveHostGroups(policy: LiveKacPolicy): string[] {
  if (Array.isArray(policy.host_groups)) {
    return policy.host_groups.filter((id): id is string => typeof id === 'string')
  }
  return (policy.groups ?? [])
    .map((g) => g.id)
    .filter((id): id is string => typeof id === 'string')
}
