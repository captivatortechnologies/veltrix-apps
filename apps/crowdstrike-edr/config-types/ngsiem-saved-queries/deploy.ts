import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createEntity,
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
} from '../../lib/entityAdapter'
import { extractSavedQuerySpecs, type LiveSavedQuery, type SavedQuerySpec } from './validate'

// =============================================================================
// NG-SIEM Saved Query API surface (verified against FalconPy `ngsiem`
// _endpoint/_ngsiem.py). This content type uses TEMPLATE-SPLIT CRUD:
//   - create:  POST   /ngsiem-content/entities/savedqueries-template/v1
//   - update:  PATCH  /ngsiem-content/entities/savedqueries-template/v1
//   - get:     GET    /ngsiem-content/entities/savedqueries-template/v1?ids=…
//   - list:    GET    /ngsiem-content/queries/savedqueries/v1?filter=…   (ids)
//   - delete:  DELETE /ngsiem-content/entities/savedqueries/v1?ids=…
//
// The read path (list ids → get templates by id, matched on `name`) fits the
// generic entity adapter exactly, so findEntityByIdentity/getEntities are
// reused. Delete lives under the NON-template collection, so a second endpoints
// object routes it there.
//
// IMPORTANT / UNVERIFIED — TRANSPORT: FalconPy models create/update as a
// multipart `yaml_template` FILE upload (plus a `search_domain` form field),
// NOT a JSON body. FalconClient NOW supports multipart (client.requestMultipart),
// so the remaining blockers to wiring it are the exact `yaml_template` schema and
// the `search_domain` value (not captured on the canvas) — both need a live-tenant
// check. Until then create/update send the template fields as a JSON body to the
// template endpoints as the closest supported approximation. Body field names
// (query/time_range/shared) and the create response id shape are also unverified;
// see LiveSavedQuery. Read/list/delete/drift work today over JSON + query params.
// =============================================================================

/** Read + create + update route: list ids, get templates, POST/PATCH template. */
export const SAVED_QUERY_ENDPOINTS: EntityEndpoints = {
  entity: '/ngsiem-content/entities/savedqueries-template/v1',
  queries: '/ngsiem-content/queries/savedqueries/v1',
  identityField: 'name',
}

/** Delete route: the non-template collection (get still resolves the id first). */
export const SAVED_QUERY_DELETE_ENDPOINTS: EntityEndpoints = {
  entity: '/ngsiem-content/entities/savedqueries/v1',
  queries: '/ngsiem-content/queries/savedqueries/v1',
  identityField: 'name',
}

/** Saved query fields this app manages and can restore on rollback. */
export interface SavedQueryRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    query?: string
    time_range?: string
    shared?: boolean
  }
}

/**
 * Deploy NG-SIEM saved queries to a Falcon tenant.
 *
 * For each declared query:
 *   - find it by its `name` identity (list ids → get template)
 *   - if it exists, capture prior state and PATCH the managed fields
 *   - otherwise POST a new saved query template
 *
 * Prior state is captured so rollback can revert updates and delete anything
 * this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSavedQuerySpecs(ctx.canvas).filter((s) => s.name && s.query)
  const rollbackState: SavedQueryRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = (await findEntityByIdentity(
        client,
        SAVED_QUERY_ENDPOINTS,
        spec.name,
      )) as LiveSavedQuery | null

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            description: typeof existing.description === 'string' ? existing.description : undefined,
            query: typeof existing.query === 'string' ? existing.query : undefined,
            time_range: typeof existing.time_range === 'string' ? existing.time_range : undefined,
            shared: liveShared(existing),
          },
        })

        await updateEntity(client, SAVED_QUERY_ENDPOINTS, {
          id: existing.id,
          ...buildSavedQueryBody(spec),
        })
      } else {
        const id = await createEntity(client, SAVED_QUERY_ENDPOINTS, buildSavedQueryBody(spec))
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} NG-SIEM saved query(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedQueries: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `NG-SIEM saved query deployment failed after ${deployed.length} of ${specs.length} query(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedQueries: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** The managed fields written on create/update, as the template API expects them. */
export function buildSavedQueryBody(spec: SavedQuerySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    query: spec.query,
    shared: spec.shared,
  }
  if (spec.description) body.description = spec.description
  if (spec.timeRange) body.time_range = spec.timeRange
  return body
}

/** Normalize the live "shared" flag across its possible field names. */
export function liveShared(live: LiveSavedQuery): boolean {
  if (typeof live.shared === 'boolean') return live.shared
  if (typeof live.is_shared === 'boolean') return live.is_shared
  return false
}
