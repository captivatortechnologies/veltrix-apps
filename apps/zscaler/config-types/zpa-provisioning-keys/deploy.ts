import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  DEFAULT_MAX_USAGE,
  extractProvisioningKeySpecs,
  type LiveProvisioningKey,
  type ProvisioningKeySpec,
} from './validate'

/**
 * Rollback entry for one provisioning key. `associationType` is threaded through
 * so rollback can rebuild the parameterized CRUD path
 * (`/associationType/{associationType}/provisioningKey/{id}`).
 *
 * ⚠ `prior` never carries the key SECRET (`provisioningKey`) — only the id and
 * the managed scalar settings needed to restore an updated key.
 */
export interface ProvisioningKeyRollbackEntry {
  name: string
  associationType: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    maxUsage?: number
    enabled?: boolean
    zcomponentId?: string
    enrollmentCertId?: string
  }
}

/**
 * Deploy ZPA provisioning keys via the Zscaler OneAPI.
 *
 * Identity is the pair (association_type, NAME); ZPA has no upsert. For each key
 * we resolve the referenced component group NAME → zcomponentId (from
 * /appConnectorGroup or /serviceEdgeGroup, chosen by association type) and the
 * enrollment certificate NAME → enrollmentCertId, then list
 * /associationType/{type}/provisioningKey, match by name, and PUT an existing
 * key or POST a new one. ZPA changes apply IMMEDIATELY — there is no activation.
 *
 * ⚠ The create response contains the generated key SECRET; only its `id` is ever
 * read. The secret is never stored in rollback state, artifacts or logs.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built
  if (!client.hasCustomerId) {
    return { success: false, message: MISSING_CUSTOMER_ID_MESSAGE }
  }

  const specs = extractProvisioningKeySpecs(ctx.canvas).filter((s) => s.name && s.associationType)
  const rollbackState: ProvisioningKeyRollbackEntry[] = []
  const createdKeys: Array<{ id: string; associationType: string }> = []
  const deployed: string[] = []

  // Resolver caches — resolve each referenced collection at most once per deploy.
  const componentGroupsByType = new Map<string, Map<string, string>>()
  const keysByType = new Map<string, Map<string, LiveProvisioningKey>>()
  let enrollmentCerts: Map<string, string> | null = null

  try {
    for (const spec of specs) {
      const zcomponentId = await resolveComponentGroupId(client, spec, componentGroupsByType)

      if (!enrollmentCerts) enrollmentCerts = await listEnrollmentCerts(client)
      const enrollmentCertId = enrollmentCerts.get(spec.enrollmentCertName)
      if (!enrollmentCertId) {
        throw new Error(
          `Enrollment certificate "${spec.enrollmentCertName}" for provisioning key "${spec.name}" was not found in the tenant — create it first`,
        )
      }

      const existing = await getKeysByName(client, spec.associationType, keysByType)
      const live = existing.get(spec.name)
      const base = `/associationType/${spec.associationType}/provisioningKey`

      if (live && live.id != null) {
        // Capture prior scalar state (never the key secret) for rollback.
        rollbackState.push({
          name: spec.name,
          associationType: spec.associationType,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            maxUsage: live.maxUsage != null ? Number(live.maxUsage) : undefined,
            enabled: live.enabled ?? true,
            zcomponentId: live.zcomponentId,
            enrollmentCertId: live.enrollmentCertId,
          },
        })
        const res = await client.zpa('PUT', `${base}/${live.id}`, {
          body: buildPayload(spec, zcomponentId, enrollmentCertId, live.id),
        })
        if (!res.ok) {
          throw new Error(`Failed to update provisioning key "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', base, {
          body: buildPayload(spec, zcomponentId, enrollmentCertId),
        })
        if (!res.ok) {
          throw new Error(`Failed to create provisioning key "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        // Read ONLY the id from the create response — never the `provisioningKey`
        // secret value it also returns.
        const created = parseJson<{ id?: string }>(res.body)
        if (created?.id == null) {
          throw new Error(`Provisioning key "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({
          name: spec.name,
          associationType: spec.associationType,
          existed: false,
          id: created.id,
        })
        createdKeys.push({ id: created.id, associationType: spec.associationType })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA provisioning key(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedProvisioningKeys: deployed },
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  } catch (error) {
    return {
      success: false,
      message: `Provisioning key deployment failed after ${deployed.length} of ${specs.length} key(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedProvisioningKeys: deployed },
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  }
}

// --- Helpers ---

/** The component group collection referenced by an association type. */
export function componentGroupPath(associationType: string): string {
  return associationType === 'SERVICE_EDGE_GRP' ? '/serviceEdgeGroup' : '/appConnectorGroup'
}

/**
 * List every provisioning key for one association type; throws on a non-OK
 * response. Shared with drift + healthCheck.
 */
export async function listProvisioningKeys(
  client: ZscalerClient,
  associationType: string,
): Promise<LiveProvisioningKey[]> {
  const res = await client.zpaGetAll<LiveProvisioningKey>(
    `/associationType/${associationType}/provisioningKey`,
  )
  if (!res.ok) {
    throw new Error(
      `Failed to list provisioning keys for ${associationType}: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Live provisioning keys for one association type as a name → key map (cached). */
async function getKeysByName(
  client: ZscalerClient,
  associationType: string,
  cache: Map<string, Map<string, LiveProvisioningKey>>,
): Promise<Map<string, LiveProvisioningKey>> {
  let map = cache.get(associationType)
  if (!map) {
    const items = await listProvisioningKeys(client, associationType)
    map = new Map(items.filter((k) => k.name).map((k) => [k.name as string, k]))
    cache.set(associationType, map)
  }
  return map
}

/** Resolve the component group NAME → zcomponentId for a spec (cached per type). */
async function resolveComponentGroupId(
  client: ZscalerClient,
  spec: ProvisioningKeySpec,
  cache: Map<string, Map<string, string>>,
): Promise<string> {
  let map = cache.get(spec.associationType)
  if (!map) {
    const path = componentGroupPath(spec.associationType)
    const res = await client.zpaGetAll<{ id?: string; name?: string }>(path)
    if (!res.ok) {
      throw new Error(
        `Failed to list component groups (${path}): ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
      )
    }
    map = new Map(res.items.filter((g) => g.name && g.id != null).map((g) => [g.name as string, g.id as string]))
    cache.set(spec.associationType, map)
  }
  const id = map.get(spec.componentGroupName)
  if (!id) {
    const label = spec.associationType === 'SERVICE_EDGE_GRP' ? 'Service Edge group' : 'App Connector group'
    throw new Error(
      `${label} "${spec.componentGroupName}" for provisioning key "${spec.name}" was not found in the tenant — create it first`,
    )
  }
  return id
}

/**
 * List enrollment certificates as a name → id map. Prefers the v2 endpoint and
 * falls back to v1 (older tenants only expose v1).
 */
export async function listEnrollmentCerts(client: ZscalerClient): Promise<Map<string, string>> {
  let res = await client.zpaGetAll<{ id?: string; name?: string }>('/enrollmentCert', {}, 'v2')
  if (!res.ok) {
    res = await client.zpaGetAll<{ id?: string; name?: string }>('/enrollmentCert', {}, 'v1')
  }
  if (!res.ok) {
    throw new Error(
      `Failed to list enrollment certificates: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return new Map(res.items.filter((c) => c.name && c.id != null).map((c) => [c.name as string, c.id as string]))
}

/**
 * Build the write body. ZPA represents maxUsage as a string. The key SECRET is
 * never part of a write body — ZPA generates it on create and it is write-only.
 */
function buildPayload(
  spec: ProvisioningKeySpec,
  zcomponentId: string,
  enrollmentCertId: string,
  id?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    maxUsage: String(spec.maxUsage ?? DEFAULT_MAX_USAGE),
    enrollmentCertId,
    zcomponentId,
    enabled: spec.enabled,
  }
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (id != null) payload.id = id
  return payload
}
