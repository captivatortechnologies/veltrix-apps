import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import { extractMappingSpecs, parseConfigObject, type LiveMapping, type MappingSpec } from './validate'

export interface ProfileMappingRollbackEntry {
  /** The resolved mapping id this deploy updated. */
  mappingId: string
  sourceId: string
  targetId: string
  /**
   * The prior state of every property mapping this deploy managed: target property
   * name -> prior `{ expression, pushStatus }` (when it existed) or
   * `{ expression: null, pushStatus: null }` when it did not (a null-pair re-removes
   * on rollback a property this deploy added). Replayed verbatim on rollback.
   */
  priorProperties: Record<string, unknown>
}

/**
 * Deploy profile-mapping property expressions to an Okta org. Mappings are
 * UPDATE-ONLY (the mapping object is never created or deleted), so for each declared
 * (source, target) mapping:
 *   - RESOLVE the mapping   — GET /mappings?sourceId=&targetId= (exactly one match)
 *   - GET the full mapping  — capture the prior state of the managed properties
 *   - POST the mapping with a `properties` patch — Okta MERGES it key-by-key, so ONLY
 *     the declared target-property names are touched. A value of
 *     `{ expression: null, pushStatus: null }` removes that property mapping;
 *     unmanaged property mappings are never pruned.
 *
 * A zero-result resolve means no mapping exists between the source and target —
 * surfaced clearly (mappings are created implicitly when a source/target profile is
 * connected; verify the ids and that the app/user-type is provisioned).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractMappingSpecs(ctx.canvas).filter(
    (s): s is MappingSpec & { propertiesJson: string } => {
      if (!s.sourceId || !s.targetId || !s.propertiesJson) return false
      const parsed = parseConfigObject(s.propertiesJson)
      return parsed !== null && Object.keys(parsed).length > 0
    },
  )
  const rollbackState: ProfileMappingRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = mappingLabel(spec.sourceId, spec.targetId)
      // Guaranteed non-null object by the filter above.
      const declared = parseConfigObject(spec.propertiesJson) as Record<string, unknown>

      // Resolve the (source, target) mapping — exactly one must exist (update-only).
      const resolved = await resolveMapping(client, spec.sourceId, spec.targetId)
      const mappingId = resolved.id
      if (!mappingId) {
        throw new Error(`Resolved profile mapping for ${label} has no id`)
      }

      // GET the full mapping to capture the prior state of every managed property.
      const full = await getMappingById(client, mappingId)
      if (!full) {
        throw new Error(`Profile mapping ${mappingId} for ${label} no longer exists`)
      }

      const liveProps = full.properties ?? {}
      const priorProperties: Record<string, unknown> = {}
      for (const name of Object.keys(declared)) {
        priorProperties[name] = Object.prototype.hasOwnProperty.call(liveProps, name)
          ? liveProps[name]
          : { expression: null, pushStatus: null }
      }
      rollbackState.push({
        mappingId,
        sourceId: spec.sourceId,
        targetId: spec.targetId,
        priorProperties,
      })

      const res = await client.request('POST', mappingPath(mappingId), {
        body: buildMappingUpdateBody(declared),
      })
      if (!res.ok) {
        throw new Error(`Failed to update property mappings for ${label}: ${oktaErrorMessage(res)}`)
      }

      const count = Object.keys(declared).length
      deployed.push(`${label} (${count} prop)`)
    }

    return {
      success: true,
      message: `Deployed property mappings to ${deployed.length} mapping(s) on Okta org at ${baseUrl}: ${
        deployed.join(', ') || 'none'
      }.`,
      artifacts: { baseUrl, deployedMappings: deployed },
      rollbackData: { previousState: rollbackState, createdIds: [] },
    }
  } catch (error) {
    return {
      success: false,
      message: `Profile mapping deployment failed after ${deployed.length} of ${specs.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedMappings: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds: [] },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Human label for a mapping, e.g. `source "oty1" -> target "0oa2"`. */
export function mappingLabel(sourceId: string, targetId: string): string {
  return `source "${sourceId}" -> target "${targetId}"`
}

/** REST path for a single mapping (id URL-encoded). */
export function mappingPath(mappingId: string): string {
  return `/mappings/${encodeURIComponent(mappingId)}`
}

/**
 * Build the update (POST) body — a partial patch of the mapping's property set. Okta
 * merges `properties` key-by-key: a value `{ expression, pushStatus }` adds/updates
 * it, a value `{ expression: null, pushStatus: null }` removes it. Only the declared
 * target-property names are ever written.
 */
export function buildMappingUpdateBody(properties: Record<string, unknown>): Record<string, unknown> {
  return { properties }
}

/**
 * Resolve the single mapping between a source and a target. Throws when zero match
 * (no mapping exists yet) or more than one match (ambiguous).
 */
export async function resolveMapping(
  client: OktaClient,
  sourceId: string,
  targetId: string,
): Promise<LiveMapping> {
  const res = await client.getAll<LiveMapping>(
    '/mappings?sourceId=' + encodeURIComponent(sourceId) + '&targetId=' + encodeURIComponent(targetId),
  )
  if (!res.ok) {
    throw new Error(
      `Failed to list profile mappings for ${mappingLabel(sourceId, targetId)}: ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  const items = res.items ?? []
  if (items.length === 0) {
    throw new Error(
      `No profile mapping exists between source "${sourceId}" and target "${targetId}" — mappings are created implicitly when a source/target profile is connected; verify the ids and that the app/user-type is provisioned.`,
    )
  }
  if (items.length > 1) {
    throw new Error(
      `Ambiguous: ${items.length} profile mappings match source "${sourceId}" and target "${targetId}" — expected exactly one. Verify the source and target ids.`,
    )
  }
  return items[0]
}

/** Fetch a single mapping by id; null on 404. */
export async function getMappingById(client: OktaClient, id: string): Promise<LiveMapping | null> {
  const res = await client.request('GET', mappingPath(id))
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch profile mapping ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveMapping>(res.body)
}
