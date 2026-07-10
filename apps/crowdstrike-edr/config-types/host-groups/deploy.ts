import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import { extractHostGroupSpecs, type HostGroupSpec, type LiveHostGroup } from './validate'

export interface HostGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: Partial<Pick<LiveHostGroup, 'name' | 'description' | 'assignment_rule'>>
}

/**
 * Deploy host groups to a Falcon tenant via the Host Group API.
 *
 * For each declared group:
 *   - GET   /devices/combined/host-groups/v1?filter=name:'…'  — find + capture prior state
 *   - PATCH /devices/entities/host-groups/v1                  — update existing
 *   - POST  /devices/entities/host-groups/v1                  — create missing
 *
 * group_type is immutable via the API, so a mismatch on an existing group
 * fails the deployment rather than silently diverging from declared state.
 * Static group membership is managed via host actions in the Falcon console,
 * not by this app — only the group object itself is managed here.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractHostGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: HostGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findHostGroup(client, spec.name)

      if (existing) {
        if (existing.group_type && existing.group_type !== spec.groupType) {
          throw new Error(
            `Host group "${spec.name}": group_type is immutable (live "${existing.group_type}", canvas "${spec.groupType}"). ` +
              'Delete and recreate the group to change its type.',
          )
        }

        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empties so rollback can clear values the
            // deployment sets on a group that previously had none.
            description: existing.description ?? '',
            assignment_rule: existing.assignment_rule,
          },
        })

        const res = await client.request('PATCH', '/devices/entities/host-groups/v1', {
          body: { resources: [buildUpdatePayload(spec, existing.id as string)] },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update host group "${spec.name}": ${patchFailure}`)
        }
      } else {
        const res = await client.request('POST', '/devices/entities/host-groups/v1', {
          body: { resources: [buildCreatePayload(spec)] },
        })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to create host group "${spec.name}": ${createFailure}`)
        }
        const created = parseEnvelope<LiveHostGroup>(res.body)?.resources?.[0]
        rollbackState.push({ name: spec.name, existed: false, id: created?.id })
        if (!created?.id) {
          throw new Error(
            `Host group "${spec.name}" was created but the API returned no group id`,
          )
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} host group(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Host group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Look up a host group by exact name; null when absent. */
export async function findHostGroup(
  client: FalconClient,
  name: string,
): Promise<LiveHostGroup | null> {
  const res = await client.request('GET', '/devices/combined/host-groups/v1', {
    query: { filter: `name:'${fqlEscape(name)}'`, limit: 10 },
  })
  if (!res.ok) {
    throw new Error(`Failed to search host group "${name}": ${falconErrorMessage(res)}`)
  }
  const groups = parseEnvelope<LiveHostGroup>(res.body)?.resources ?? []
  // The name filter matches case-insensitively — pin to the exact declared
  // name, tolerating a casing difference only when it is unambiguous. Never
  // adopt an arbitrary filter hit: mutating the wrong group would change
  // which hosts inherit the policies and IOCs that target it.
  const exact = groups.find((g) => g.name === name)
  if (exact) return exact
  const caseInsensitive = groups.filter((g) => g.name?.toLowerCase() === name.toLowerCase())
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

function buildCreatePayload(spec: HostGroupSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: spec.name, group_type: spec.groupType }
  if (spec.description) payload.description = spec.description
  // assignment_rule is only valid on dynamic groups
  if (spec.groupType === 'dynamic' && spec.assignmentRule) {
    payload.assignment_rule = spec.assignmentRule
  }
  return payload
}

function buildUpdatePayload(spec: HostGroupSpec, id: string): Record<string, unknown> {
  // description is always sent so clearing it on the canvas converges the
  // live group (and drift detection agrees with deploy about the target state)
  const payload: Record<string, unknown> = {
    id,
    name: spec.name,
    description: spec.description ?? '',
  }
  if (spec.groupType === 'dynamic' && spec.assignmentRule) {
    payload.assignment_rule = spec.assignmentRule
  }
  return payload
}
