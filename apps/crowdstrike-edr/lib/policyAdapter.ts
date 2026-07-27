// =============================================================================
// Shared adapter for the Falcon "policy" family (/policy/entities/<type>/vN).
//
// Prevention, Sensor Update, Response, USB Device Control, Firewall, and
// Content Update policies all share the SAME lifecycle mechanics, only the
// endpoint paths and the settings body differ:
//   - find an existing policy by name (the exact-name FQL filter silently
//     returns empty for custom names, so use name:~'…' contains + client-side
//     exact pin, paged so a match past the first page is never missed)
//   - new policies are always created disabled → converge enablement via a
//     separate <type>-actions call
//   - host-group attach/detach is a <type>-actions call, not a field
//   - precedence is a separate global endpoint (not handled here)
//
// Each config type supplies its own PolicyEndpoints + settings serialization;
// this module owns the find / action / host-group-sync transport so ~6 policy
// types share one proven code path. Modeled on the shipped prevention-policies
// handlers (config-types/prevention-policies/deploy.ts).
// =============================================================================

import {
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from './falcon'

export interface PolicyEndpoints {
  /** Entity path, e.g. '/policy/entities/sensor-update/v2'. */
  entity: string
  /** Combined (query+get) path, e.g. '/policy/combined/sensor-update/v1'. */
  combined: string
  /** Actions path, e.g. '/policy/entities/sensor-update-actions/v2'. */
  actions: string
  /** True when the family filters by platform_name (Windows/Mac/Linux). */
  perPlatform: boolean
}

/** Common shape across policy families; `settings` is family-specific (unknown here). */
export interface LivePolicy {
  id?: string
  name?: string
  description?: string
  platform_name?: string
  enabled?: boolean
  groups?: Array<{ id?: string; name?: string }>
  settings?: unknown
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  [key: string]: unknown
}

export type PolicyActionName = 'enable' | 'disable' | 'add-host-group' | 'remove-host-group'

/** Host-group ids currently attached to a live policy. */
export function currentGroupIds(policy: LivePolicy): string[] {
  return (policy.groups ?? [])
    .map((g) => g.id)
    .filter((id): id is string => typeof id === 'string')
}

/**
 * Look up a policy by exact name (and platform, when the family is
 * per-platform). Uses the documented contains match (name:~'…') because exact
 * filters silently return empty for custom names, pins the exact name
 * client-side, and pages through every result so a match past the first page
 * is never missed. A single unambiguous case-insensitive match is tolerated.
 */
export async function findPolicyByName(
  client: FalconClient,
  endpoints: PolicyEndpoints,
  name: string,
  platform?: string,
): Promise<LivePolicy | null> {
  const limit = 500
  const caseInsensitive: LivePolicy[] = []
  const filter =
    endpoints.perPlatform && platform
      ? `platform_name:'${fqlEscape(platform)}'+name:~'${fqlEscape(name)}'`
      : `name:~'${fqlEscape(name)}'`

  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', endpoints.combined, {
      query: { filter, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search policy "${name}": ${falconErrorMessage(res)}`)
    }
    const policies = parseEnvelope<LivePolicy>(res.body)?.resources ?? []

    const exact = policies.find((p) => p.name === name)
    if (exact) return exact
    caseInsensitive.push(...policies.filter((p) => p.name?.toLowerCase() === name.toLowerCase()))

    if (policies.length < limit) break
  }

  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** enable/disable a policy, or attach/detach a host group, via `<type>-actions`. */
export async function policyAction(
  client: FalconClient,
  endpoints: PolicyEndpoints,
  policyId: string,
  action: PolicyActionName,
  groupId?: string,
): Promise<void> {
  const body: Record<string, unknown> = { ids: [policyId] }
  if (groupId) {
    body.action_parameters = [{ name: 'group_id', value: groupId }]
  }
  const res = await client.request('POST', endpoints.actions, {
    query: { action_name: action },
    body,
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Policy action "${action}" failed: ${failure}`)
  }
}

/**
 * Converge a policy's host-group assignments to exactly `desired`. When
 * `record` is given, every successful attach/detach is appended to it so a
 * rollback can reverse exactly the deltas this deployment applied, even after
 * a partial failure.
 */
export async function syncHostGroups(
  client: FalconClient,
  endpoints: PolicyEndpoints,
  policyName: string,
  policyId: string,
  desired: string[],
  current: string[],
  record?: { groupsAdded: string[]; groupsRemoved: string[] },
): Promise<void> {
  const desiredSet = new Set(desired)
  const currentSet = new Set(current)

  for (const groupId of desired) {
    if (!currentSet.has(groupId)) {
      try {
        await policyAction(client, endpoints, policyId, 'add-host-group', groupId)
        record?.groupsAdded.push(groupId)
      } catch (error) {
        throw new Error(
          `Policy "${policyName}": failed to attach host group ${groupId} — ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        )
      }
    }
  }
  for (const groupId of current) {
    if (!desiredSet.has(groupId)) {
      try {
        await policyAction(client, endpoints, policyId, 'remove-host-group', groupId)
        record?.groupsRemoved.push(groupId)
      } catch (error) {
        throw new Error(
          `Policy "${policyName}": failed to detach host group ${groupId} — ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        )
      }
    }
  }
}
