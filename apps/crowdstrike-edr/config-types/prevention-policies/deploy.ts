import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  extractPolicySpecs,
  flattenLiveSettings,
  parsePolicySettings,
  type LivePreventionPolicy,
  type PolicySetting,
} from './validate'

export interface PolicyRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    /** Prior values of only the settings this deployment changed. */
    settings: PolicySetting[]
    /** Host groups this deployment attached — rollback detaches them. */
    groupsAdded: string[]
    /** Host groups this deployment detached — rollback re-attaches them. */
    groupsRemoved: string[]
  }
}

/**
 * Deploy prevention policies to a Falcon tenant via the Prevention Policy API.
 *
 * For each declared policy:
 *   - GET   /policy/combined/prevention/v1?filter=platform_name:'…'+name:~'…'  — find + capture prior state
 *   - PATCH /policy/entities/prevention/v1   — update existing (declared settings merge per-id)
 *   - POST  /policy/entities/prevention/v1   — create missing (new policies start disabled)
 *   - POST  /policy/entities/prevention-actions/v1?action_name=enable|disable — converge enablement
 *   - POST  …?action_name=add-host-group|remove-host-group — converge assignments to the declared list
 *
 * Only the settings declared on the canvas are written; all other policy
 * settings keep their tenant values. platform_name is immutable via the API.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { settings, errors: settingErrors } = parsePolicySettings(spec.settingsRaw)
      if (settingErrors.length > 0) {
        throw new Error(`Policy "${spec.name}": invalid settings — ${settingErrors[0]}`)
      }

      const existing = await findPreventionPolicy(client, spec.name, spec.platform)

      if (existing?.id) {
        const declaredIds = new Set(settings.map((s) => s.id))
        const entry: PolicyRollbackEntry = {
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empty so rollback can clear a description
            // this deployment sets on a policy that previously had none.
            description: existing.description ?? '',
            enabled: existing.enabled,
            settings: flattenLiveSettings(existing).filter((s) => declaredIds.has(s.id)),
            groupsAdded: [],
            groupsRemoved: [],
          },
        }
        rollbackState.push(entry)

        // description is always sent so clearing it on the canvas converges
        // the live policy (and drift detection agrees with deploy)
        const update: Record<string, unknown> = {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
        }
        if (settings.length > 0) update.settings = settings

        const res = await client.request('PATCH', '/policy/entities/prevention/v1', {
          body: { resources: [update] },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update policy "${spec.name}": ${patchFailure}`)
        }

        if (existing.enabled !== spec.enabled) {
          await policyAction(client, existing.id, spec.enabled ? 'enable' : 'disable')
        }
        // Records each successful attach/detach on entry.prior so rollback
        // can reverse exactly the assignments this deployment changed, even
        // after a partial failure.
        await syncHostGroups(
          client,
          spec.name,
          existing.id,
          spec.hostGroups,
          currentGroupIds(existing),
          entry.prior,
        )
      } else {
        const create: Record<string, unknown> = { name: spec.name, platform_name: spec.platform }
        if (spec.description !== undefined) create.description = spec.description
        if (settings.length > 0) create.settings = settings

        const res = await client.request('POST', '/policy/entities/prevention/v1', {
          body: { resources: [create] },
        })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to create policy "${spec.name}": ${createFailure}`)
        }
        const created = parseEnvelope<LivePreventionPolicy>(res.body)?.resources?.[0]
        rollbackState.push({
          name: spec.name,
          platform: spec.platform,
          existed: false,
          id: created?.id,
        })
        if (!created?.id) {
          throw new Error(`Policy "${spec.name}" was created but the API returned no policy id`)
        }

        // New policies always start disabled
        if (spec.enabled) await policyAction(client, created.id, 'enable')
        await syncHostGroups(client, spec.name, created.id, spec.hostGroups, [])
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} prevention policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Prevention policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Look up a prevention policy by exact name and platform. Exact-match name
 * filters silently return empty for most custom policy names, so this uses
 * the documented contains match (name:~'…') and pins the exact name
 * client-side.
 */
export async function findPreventionPolicy(
  client: FalconClient,
  name: string,
  platform: string,
): Promise<LivePreventionPolicy | null> {
  const limit = 500
  const caseInsensitive: LivePreventionPolicy[] = []

  // The contains match can hit many policies — page through all of them so
  // the exact-name pin never misses a policy beyond the first page.
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', '/policy/combined/prevention/v1', {
      query: {
        filter: `platform_name:'${fqlEscape(platform)}'+name:~'${fqlEscape(name)}'`,
        limit,
        offset,
      },
    })
    if (!res.ok) {
      throw new Error(`Failed to search policy "${name}": ${falconErrorMessage(res)}`)
    }
    const policies = parseEnvelope<LivePreventionPolicy>(res.body)?.resources ?? []

    const exact = policies.find((p) => p.name === name)
    if (exact) return exact
    caseInsensitive.push(...policies.filter((p) => p.name?.toLowerCase() === name.toLowerCase()))

    if (policies.length < limit) break
  }

  // Tolerate a casing difference only when it is unambiguous — adopting an
  // arbitrary match would rewrite a policy the canvas never declared.
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

export function currentGroupIds(policy: LivePreventionPolicy): string[] {
  return (policy.groups ?? [])
    .map((g) => g.id)
    .filter((id): id is string => typeof id === 'string')
}

/** enable/disable a policy, or attach/detach a host group. */
export async function policyAction(
  client: FalconClient,
  policyId: string,
  action: 'enable' | 'disable' | 'add-host-group' | 'remove-host-group',
  groupId?: string,
): Promise<void> {
  const body: Record<string, unknown> = { ids: [policyId] }
  if (groupId) {
    body.action_parameters = [{ name: 'group_id', value: groupId }]
  }
  const res = await client.request('POST', '/policy/entities/prevention-actions/v1', {
    query: { action_name: action },
    body,
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Policy action "${action}" failed: ${failure}`)
  }
}

/**
 * Converge a policy's host group assignments to exactly the declared list.
 * When `record` is given, every successful attach/detach is appended to it —
 * rollback reverses those exact deltas without re-reading live state.
 */
export async function syncHostGroups(
  client: FalconClient,
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
        await policyAction(client, policyId, 'add-host-group', groupId)
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
        await policyAction(client, policyId, 'remove-host-group', groupId)
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
