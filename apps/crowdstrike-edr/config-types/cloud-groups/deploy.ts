import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, parseEnvelope, type FalconClient } from '../../lib/falcon'
import {
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
  type LiveEntity,
} from '../../lib/entityAdapter'
import {
  extractCloudGroupSpecs,
  parseScoping,
  type CloudGroupSelectors,
  type CloudGroupSpec,
} from './validate'

/**
 * Cloud Groups API surface (verified against FalconPy `cloud_security` +
 * gofalcon). query→get→update→delete match the generic entity adapter; identity
 * is `name`. NOTE: create is handled directly here (not via the adapter's
 * createEntity) because CreateCloudGroupExternal returns `resources: [<id>]` as
 * bare id strings, not `{ id }` objects.
 */
export const CLOUD_GROUP_ENDPOINTS: EntityEndpoints = {
  entity: '/cloud-security/entities/cloud-groups/v1',
  queries: '/cloud-security/queries/cloud-groups/v1',
  identityField: 'name',
}

/** A live cloud group as returned by GET /cloud-security/entities/cloud-groups/v1. */
export interface LiveCloudGroup extends LiveEntity {
  business_impact?: string
  business_unit?: string
  environment?: string
  owners?: string[]
  selectors?: CloudGroupSelectors
  created_by?: string
  updated_by?: string
  updated_at?: string
}

/** Cloud group fields this app manages and can restore on rollback. */
export interface CloudGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    business_impact?: string
    business_unit?: string
    environment?: string
    owners?: string[]
    selectors?: CloudGroupSelectors
  }
}

/**
 * Deploy cloud groups to a Falcon tenant via the Cloud Groups API.
 *
 * For each declared group:
 *   - find it by its `name` identity (query → get, via the entity adapter)
 *   - if it exists, PATCH the managed fields (body carries its id)
 *   - otherwise POST a new group
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

  const specs = extractCloudGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: CloudGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = (await findEntityByIdentity(
        client,
        CLOUD_GROUP_ENDPOINTS,
        spec.name,
      )) as LiveCloudGroup | null

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            description: typeof existing.description === 'string' ? existing.description : undefined,
            business_impact: existing.business_impact,
            business_unit: existing.business_unit,
            environment: existing.environment,
            owners: Array.isArray(existing.owners) ? existing.owners : [],
            selectors: existing.selectors,
          },
        })

        await updateEntity(client, CLOUD_GROUP_ENDPOINTS, {
          id: existing.id,
          ...buildGroupBody(spec),
        })
      } else {
        const id = await createCloudGroup(client, buildGroupBody(spec))
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} cloud group(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Cloud group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** The managed fields written on create/update, as the API expects them. */
export function buildGroupBody(spec: CloudGroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    business_impact: spec.businessImpact,
    environment: spec.environment,
    owners: spec.owners,
  }
  if (spec.description) body.description = spec.description
  if (spec.businessUnit) body.business_unit = spec.businessUnit
  const selectors = parseScoping(spec.scopingRaw).selectors
  if (selectors) body.selectors = selectors
  return body
}

/**
 * Create a cloud group and return its new id. Unlike the generic adapter's
 * createEntity, CreateCloudGroupExternal returns the id as a bare string in
 * `resources[0]`, so the id is read as a string rather than `resources[0].id`.
 */
export async function createCloudGroup(
  client: FalconClient,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await client.request('POST', CLOUD_GROUP_ENDPOINTS.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create group "${String(body.name)}": ${failure}`)
  const id = parseEnvelope<string>(res.body)?.resources?.[0]
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Group "${String(body.name)}" was created but the API returned no group id`)
  }
  return id
}
