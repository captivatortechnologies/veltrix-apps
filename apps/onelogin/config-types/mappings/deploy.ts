import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, parseJson, oneLoginErrorMessage, reconcileOrder, type OneLoginClient } from '../../lib/oneLogin'
import { extractMappingSpecs, type LiveMapping, type MappingSpec } from './validate'

/** The full writable surface of a mapping - everything create/update accepts. */
export interface MappingWriteInput {
  name: string
  match: 'all' | 'any'
  enabled: boolean
  conditions: unknown[]
  actions: unknown[]
}

export interface MappingRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** Prior writable state, captured before an update so rollback can PUT it back. */
  prior?: MappingWriteInput
}

/**
 * Deploy OneLogin user mappings via the User Mappings API.
 *
 * ONE item = ONE mapping, matched on NAME (OneLogin has no upsert):
 *   - list GET  /api/2/mappings          (client.getAll, Link-header paginated)
 *   - PUT       /api/2/mappings/{id}     - replace an existing mapping's writable fields
 *   - POST      /api/2/mappings          - create a missing one (capture the new id)
 *
 * Then reconciles ORDER: OneLogin's Bulk Sort (PUT /api/2/mappings/sort)
 * requires the COMPLETE id list for the account (a partial list 422s), so
 * this app captures the full live order BEFORE making any change, then uses
 * {@link reconcileOrder} to non-destructively re-insert the managed mappings
 * (in the exact order declared) at the position of the first one that
 * already existed - see canvas.yaml for the full reasoning.
 *
 * Never deletes a mapping absent from this canvas - rollback only reverts
 * what THIS deploy created, changed, or reordered.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractMappingSpecs(ctx.canvas).filter((s) => s.name && s.conditionsJson && s.actionsJson)
  const rollbackState: MappingRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const liveMappings = await listMappings(client)
    // Captured BEFORE any change - the exact order rollback restores.
    const originalFullOrder = liveMappings.map((m) => m.id).filter((id): id is number => typeof id === 'number')

    const managedIds: number[] = []

    for (const spec of specs) {
      const input = specToWriteInput(spec)
      const existing = liveMappings.find((m) => m.name === spec.name) ?? null

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: liveMappingToWriteInput(existing),
        })
        managedIds.push(existing.id)

        const res = await client.request('PUT', `/api/2/mappings/${existing.id}`, { body: buildMappingBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to update mapping "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/api/2/mappings', { body: buildMappingBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to create mapping "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
        const created = parseJson<LiveMapping>(res.body)
        if (!created?.id) {
          throw new Error(`Mapping "${spec.name}" was created but the API returned no id`)
        }
        createdIds.push(created.id)
        managedIds.push(created.id)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
      }

      deployed.push(spec.name)
    }

    if (managedIds.length > 0) {
      const newOrder = reconcileOrder(
        originalFullOrder.map(String),
        managedIds.map(String),
      ).map(Number)
      await sortMappings(client, newOrder)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} user mapping(s) to OneLogin account ${domain}: ${deployed.join(', ')}`,
      artifacts: { domain, deployedMappings: deployed },
      rollbackData: { previousState: rollbackState, createdIds, originalFullOrder },
    }
  } catch (error) {
    return {
      success: false,
      message: `User mapping deployment failed after ${deployed.length} of ${specs.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedMappings: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every mapping in the account, sorted by position ascending. */
export async function listMappings(client: OneLoginClient): Promise<LiveMapping[]> {
  const res = await client.getAll<LiveMapping>('/api/2/mappings')
  if (!res.ok) {
    throw new Error(`Failed to list mappings: ${oneLoginErrorMessage({ status: res.status, ok: res.ok, body: res.body, linkHeader: null })}`)
  }
  return [...res.items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
}

/** PUT /api/2/mappings/sort - the COMPLETE ordered id list for the account. */
export async function sortMappings(client: OneLoginClient, orderedIds: number[]): Promise<void> {
  const res = await client.request('PUT', '/api/2/mappings/sort', { body: orderedIds })
  if (!res.ok) {
    throw new Error(`Failed to reorder mappings: ${oneLoginErrorMessage(res)}`)
  }
}

function specToWriteInput(spec: MappingSpec): MappingWriteInput {
  return {
    name: spec.name,
    match: spec.match,
    enabled: spec.enabled,
    conditions: JSON.parse(spec.conditionsJson),
    actions: JSON.parse(spec.actionsJson),
  }
}

/** Capture a live mapping's writable fields - used both for rollback and as the base of a prior-state PUT. */
export function liveMappingToWriteInput(existing: LiveMapping): MappingWriteInput {
  return {
    name: existing.name ?? '',
    match: existing.match === 'any' ? 'any' : 'all',
    enabled: existing.enabled ?? true,
    conditions: existing.conditions ?? [],
    actions: existing.actions ?? [],
  }
}

/** Build the create/update request body from a writable-fields input. */
export function buildMappingBody(input: MappingWriteInput): Record<string, unknown> {
  return {
    name: input.name,
    match: input.match,
    enabled: input.enabled,
    conditions: input.conditions,
    actions: input.actions,
  }
}
