import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import { extractPopulationSpecs, type LivePopulation, type PopulationSpec } from './validate'

export interface PopulationRollbackEntry {
  name: string
  existed: boolean
  /** The population id PingOne assigns - the rollback key (never the name). */
  id?: string
  /** Prior population body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields PingOne returns on a population but that must never be sent back. */
export const READONLY_POPULATION_FIELDS = [
  'id',
  'environment',
  'createdAt',
  'updatedAt',
  '_links',
  'userCount',
] as const

/**
 * Deploy populations to a PingOne environment. NO UPSERT exists, so for each
 * declared population:
 *   - GET  /populations              - list (paginated) and match by name
 *   - PUT  /populations/{id}         - update an existing population (capture prior body)
 *   - POST /populations              - create a missing population (capture the new id)
 * then, only when the canvas declares a defaultIdentityProviderId, reconcile the
 * defaultIdentityProvider sub-resource:
 *   - PUT /populations/{id}/defaultIdentityProvider
 * There is no delete endpoint for that sub-resource, so a blank field is always
 * skipped - this app never attempts to clear an existing assignment.
 *
 * A matched (existing) population - including the environment's built-in
 * default population, when its name matches a declared item - is only ever
 * UPDATED in place; deploy never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractPopulationSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PopulationRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findPopulation(client, spec.name)

      let populationId: string
      if (existing && existing.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyPopulationFields(existing),
        })

        const res = await client.request('PUT', `/populations/${existing.id}`, {
          body: buildPopulationBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update population "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        populationId = existing.id
      } else {
        const res = await client.request('POST', '/populations', { body: buildPopulationBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create population "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LivePopulation>(res.body)
        if (!created?.id) {
          throw new Error(`Population "${spec.name}" was created but the API returned no id`)
        }
        populationId = created.id
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      // Set-only sub-resource: skip entirely when blank rather than attempting
      // to clear an existing assignment (there is no delete/unset endpoint).
      if (spec.defaultIdentityProviderId) {
        const idpRes = await client.request('PUT', `/populations/${populationId}/defaultIdentityProvider`, {
          body: { identityProvider: { id: spec.defaultIdentityProviderId } },
        })
        if (!idpRes.ok) {
          throw new Error(
            `Failed to set default identity provider for population "${spec.name}": ${pingOneErrorMessage(idpRes)}`,
          )
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} population(s) to PingOne environment ${environmentId}: ${deployed.join(', ')}`,
      artifacts: { environmentId, deployedPopulations: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Population deployment failed after ${deployed.length} of ${specs.length} population(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedPopulations: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a population by exact name across the paginated population list; null when absent. */
export async function findPopulation(client: PingOneClient, name: string): Promise<LivePopulation | null> {
  const res = await client.getAll<LivePopulation>('/populations', 'populations')
  if (!res.ok) {
    throw new Error(
      `Failed to list populations while resolving "${name}": ${pingOneErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
      })}`,
    )
  }
  return res.items.find((p) => p.name === name) ?? null
}

/** Fetch a single population by id; null on 404. */
export async function getPopulationById(client: PingOneClient, id: string): Promise<LivePopulation | null> {
  const res = await client.request('GET', `/populations/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch population ${id}: ${pingOneErrorMessage(res)}`)
  }
  return parseJson<LivePopulation>(res.body)
}

/**
 * Build the create/update body. `name` and `default` always ship - every other
 * field is included only when the canvas set it, mirroring how the rest of the
 * codebase's config types treat optional strings (see okta-identity brands'
 * buildBrandBody): a blank optional field is left off the body rather than
 * sent as an explicit clear.
 */
export function buildPopulationBody(spec: PopulationSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, default: spec.default }
  if (spec.description) body.description = spec.description
  if (spec.preferredLanguage) body.preferredLanguage = spec.preferredLanguage
  if (spec.alternativeIdentifiers.length > 0) body.alternativeIdentifiers = spec.alternativeIdentifiers
  if (spec.passwordPolicyId) body.passwordPolicy = { id: spec.passwordPolicyId }
  return body
}

/** Copy a live population without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyPopulationFields(pop: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(pop)) {
    if (!(READONLY_POPULATION_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
