import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import { extractGroupSpecs, parseCustomData, type GroupSpec, type LiveGroup } from './validate'

/** The full writable surface of a group - everything PUT/POST accepts. */
export interface GroupWriteInput {
  name: string
  description?: string
  populationId?: string
  userFilter?: string
  externalId?: string
  customData?: Record<string, unknown>
}

export interface GroupRollbackEntry {
  name: string
  populationId?: string
  existed: boolean
  id?: string
  /** Prior writable state, captured before an update so rollback can PUT it back. */
  prior?: GroupWriteInput
}

/**
 * Deploy PingOne groups via the Groups API.
 *
 * ONE item = ONE group, matched on the (name, population.id) PAIR:
 *   - list  GET /groups         (client.getAll, HAL-paginated)
 *   - PUT   /groups/{id}        - replace an existing group's writable fields
 *   - POST  /groups             - create a missing one (capture the new id)
 *
 * The canvas is the single source of truth: the PUT/POST body is always built
 * fresh from the declared spec (never merged with the live object), so a
 * field cleared in the canvas converges to cleared on the next deploy.
 * `description` is always sent (defaulting to '') since PingOne always
 * returns one; the other optional fields (population/userFilter/externalId/
 * customData) are omitted entirely when unset so the full-replace PUT clears
 * them exactly as it would any other omitted field.
 *
 * Never deletes a group absent from this canvas - rollback only reverts what
 * THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: GroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const groups = await listGroups(client)

    for (const spec of specs) {
      const input = specToWriteInput(spec)
      const existing = findGroupMatch(groups, spec.name, spec.populationId)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          populationId: spec.populationId,
          existed: true,
          id: existing.id,
          prior: liveGroupToWriteInput(existing),
        })

        const res = await client.request('PUT', `/groups/${existing.id}`, { body: buildGroupBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to update group "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/groups', { body: buildGroupBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to create group "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LiveGroup>(res.body)
        if (!created?.id) {
          throw new Error(`Group "${spec.name}" was created but the API returned no id`)
        }
        createdIds.push(created.id)
        rollbackState.push({
          name: spec.name,
          populationId: spec.populationId,
          existed: false,
          id: created.id,
        })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} group(s) to PingOne environment ${environmentId}: ${deployed.join(', ')}`,
      artifacts: { environmentId, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every group in the environment, following HAL pagination. */
export async function listGroups(client: PingOneClient): Promise<LiveGroup[]> {
  const res = await client.getAll<LiveGroup>('/groups', 'groups')
  if (!res.ok) {
    throw new Error(
      `Failed to list groups: ${pingOneErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`,
    )
  }
  return res.items
}

/**
 * Find a live group by its logical identity - the PAIR (name, population.id).
 * A group with no population matches only another group with no population.
 */
export function findGroupMatch(groups: LiveGroup[], name: string, populationId?: string): LiveGroup | null {
  return (
    groups.find((g) => g.name === name && (g.population?.id ?? undefined) === (populationId ?? undefined)) ?? null
  )
}

function specToWriteInput(spec: GroupSpec): GroupWriteInput {
  return {
    name: spec.name,
    description: spec.description,
    populationId: spec.populationId,
    userFilter: spec.userFilter,
    externalId: spec.externalId,
    customData: spec.customDataJson ? (parseCustomData(spec.customDataJson) ?? undefined) : undefined,
  }
}

/** Capture a live group's writable fields - used both for rollback and as the base of a prior-state PUT. */
export function liveGroupToWriteInput(existing: LiveGroup): GroupWriteInput {
  return {
    name: existing.name ?? '',
    description: typeof existing.description === 'string' ? existing.description : undefined,
    populationId: existing.population?.id,
    userFilter: typeof existing.userFilter === 'string' ? existing.userFilter : undefined,
    externalId: typeof existing.externalId === 'string' ? existing.externalId : undefined,
    customData: existing.customData,
  }
}

/** Build the PUT/POST body from a writable-fields input. */
export function buildGroupBody(input: GroupWriteInput): Record<string, unknown> {
  const body: Record<string, unknown> = { name: input.name, description: input.description ?? '' }
  if (input.populationId) body.population = { id: input.populationId }
  if (input.userFilter) body.userFilter = input.userFilter
  if (input.externalId) body.externalId = input.externalId
  if (input.customData) body.customData = input.customData
  return body
}
