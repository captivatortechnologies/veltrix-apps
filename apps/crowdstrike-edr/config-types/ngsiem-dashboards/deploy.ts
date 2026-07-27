import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createEntity,
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
} from '../../lib/entityAdapter'
import {
  extractDashboardSpecs,
  parseDefinition,
  type DashboardSpec,
  type LiveDashboard,
} from './validate'

// =============================================================================
// NG-SIEM Dashboard API surface (verified against FalconPy `ngsiem`
// _endpoint/_ngsiem.py). This content type uses TEMPLATE-SPLIT CRUD:
//   - create:  POST   /ngsiem-content/entities/dashboards-template/v1
//   - update:  PATCH  /ngsiem-content/entities/dashboards-template/v1
//   - get:     GET    /ngsiem-content/entities/dashboards-template/v1?ids=…
//   - list:    GET    /ngsiem-content/queries/dashboards/v1?filter=…   (ids)
//   - delete:  DELETE /ngsiem-content/entities/dashboards/v1?ids=…
//
// The read path (list ids → get templates by id, matched on `name`) fits the
// generic entity adapter exactly, so findEntityByIdentity/getEntities are
// reused. Delete lives under the NON-template collection, so a second endpoints
// object routes it there.
//
// IMPORTANT / UNVERIFIED — TRANSPORT: FalconPy models create/update as a
// multipart `yaml_template` FILE upload (create also takes a `name` form
// field), NOT a JSON body. The shared FalconClient only sends JSON and is out
// of scope to change here, so create/update send the template fields as a JSON
// body to the template endpoints — the closest supported approximation. Making
// this production-correct needs either a multipart capability on FalconClient
// or confirmation that the endpoints also accept JSON. The body field name for
// the widget/layout (`definition`), the `shared` flag, and the create response
// id shape are also unverified; see LiveDashboard.
// =============================================================================

/** Read + create + update route: list ids, get templates, POST/PATCH template. */
export const DASHBOARD_ENDPOINTS: EntityEndpoints = {
  entity: '/ngsiem-content/entities/dashboards-template/v1',
  queries: '/ngsiem-content/queries/dashboards/v1',
  identityField: 'name',
}

/** Delete route: the non-template collection (get still resolves the id first). */
export const DASHBOARD_DELETE_ENDPOINTS: EntityEndpoints = {
  entity: '/ngsiem-content/entities/dashboards/v1',
  queries: '/ngsiem-content/queries/dashboards/v1',
  identityField: 'name',
}

/** Dashboard fields this app manages and can restore on rollback. */
export interface DashboardRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    definition?: unknown
    shared?: boolean
  }
}

/**
 * Deploy NG-SIEM dashboards to a Falcon tenant.
 *
 * For each declared dashboard:
 *   - find it by its `name` identity (list ids → get template)
 *   - if it exists, capture prior state and PATCH the managed fields
 *   - otherwise POST a new dashboard template
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

  const specs = extractDashboardSpecs(ctx.canvas).filter((s) => s.name && s.definitionRaw)
  const rollbackState: DashboardRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = (await findEntityByIdentity(
        client,
        DASHBOARD_ENDPOINTS,
        spec.name,
      )) as LiveDashboard | null

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            description: typeof existing.description === 'string' ? existing.description : undefined,
            definition: existing.definition,
            shared: liveShared(existing),
          },
        })

        await updateEntity(client, DASHBOARD_ENDPOINTS, {
          id: existing.id,
          ...buildDashboardBody(spec),
        })
      } else {
        const id = await createEntity(client, DASHBOARD_ENDPOINTS, buildDashboardBody(spec))
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} NG-SIEM dashboard(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedDashboards: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `NG-SIEM dashboard deployment failed after ${deployed.length} of ${specs.length} dashboard(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedDashboards: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** The managed fields written on create/update, as the template API expects them. */
export function buildDashboardBody(spec: DashboardSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    definition: parseDefinition(spec.definitionRaw).value ?? {},
    shared: spec.shared,
  }
  if (spec.description) body.description = spec.description
  return body
}

/** Normalize the live "shared" flag across its possible field names. */
export function liveShared(live: LiveDashboard): boolean {
  if (typeof live.shared === 'boolean') return live.shared
  if (typeof live.is_shared === 'boolean') return live.is_shared
  return false
}
