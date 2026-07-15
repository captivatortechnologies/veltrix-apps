import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractPermissionSpecs, parseJsonArray, type LivePermission, type PermissionSpec } from './validate'

export interface PermissionRollbackEntry {
  name: string
  existed: boolean
  uuid?: string
  prior?: Partial<Pick<LivePermission, 'name' | 'actions' | 'objects' | 'subjects'>>
}

/**
 * Deploy access-control permissions to a Tenable tenant via the
 * Access-Control v3 API.
 *
 * A permission grants subjects a set of actions over objects; its stable
 * identity is `permission_uuid`, but the canvas only carries the human `name`,
 * so we match on name. For each declared permission:
 *   - GET  /api/v3/access-control/permissions              — list, match on name
 *   - PUT  /api/v3/access-control/permissions/{uuid}       — update (capture prior body)
 *   - POST /api/v3/access-control/permissions              — create (capture new uuid)
 *
 * SENSITIVE RBAC: every write here changes who can do what. Rollback keys on the
 * captured permission_uuid (never the name) so a rename can still be reverted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPermissionSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PermissionRollbackEntry[] = []
  const createdUuids: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.name

      // objects/subjects are validated upstream; re-parse here to build the API
      // body and to fail loudly rather than send a malformed payload.
      const objects = parseArrayOrThrow(spec.objectsJson, label, 'objects')
      const subjects = parseArrayOrThrow(spec.subjectsJson, label, 'subjects')

      const existing = await findPermissionByName(client, spec.name)

      if (existing && existing.permission_uuid) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          uuid: existing.permission_uuid,
          prior: {
            name: existing.name,
            actions: existing.actions,
            objects: existing.objects,
            subjects: existing.subjects,
          },
        })

        const res = await client.request(
          'PUT',
          `/api/v3/access-control/permissions/${existing.permission_uuid}`,
          { body: buildPayload(spec, objects, subjects) },
        )
        if (!res.ok) {
          throw new Error(`Failed to update permission "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/api/v3/access-control/permissions', {
          body: buildPayload(spec, objects, subjects),
        })
        if (!res.ok) {
          throw new Error(`Failed to create permission "${label}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LivePermission>(res.body)
        if (!created?.permission_uuid) {
          throw new Error(`Permission "${label}" was created but the API returned no permission_uuid`)
        }
        rollbackState.push({ name: spec.name, existed: false, uuid: created.permission_uuid })
        createdUuids.push(created.permission_uuid)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} permission(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPermissions: deployed },
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  } catch (error) {
    return {
      success: false,
      message: `Permission deployment failed after ${deployed.length} of ${specs.length} permission(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPermissions: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  }
}

// --- Helpers ---

/** Re-parse an objects/subjects array for the API body; throw on bad input. */
function parseArrayOrThrow(raw: string | undefined, label: string, kind: string): unknown[] {
  const parsed = raw ? parseJsonArray(raw) : null
  if (parsed === null) {
    throw new Error(`Permission "${label}": ${kind} is not a valid JSON array`)
  }
  return parsed
}

/**
 * Find a permission by its name; null when absent.
 * GET /api/v3/access-control/permissions returns the full permission list.
 */
export async function findPermissionByName(
  client: TenableClient,
  name: string,
): Promise<LivePermission | null> {
  const res = await client.request('GET', '/api/v3/access-control/permissions')
  if (!res.ok) {
    throw new Error(`Failed to list permissions while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const permissions = parseJson<{ permissions?: LivePermission[] }>(res.body)?.permissions ?? []
  return permissions.find((p) => p.name === name) ?? null
}

/** Fetch a single permission by uuid; null on 404. */
export async function getPermissionByUuid(
  client: TenableClient,
  uuid: string,
): Promise<LivePermission | null> {
  const res = await client.request('GET', `/api/v3/access-control/permissions/${uuid}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch permission ${uuid}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LivePermission>(res.body)
}

/**
 * Build the create/update body. Objects and subjects are sent as-is (already
 * validated JSON arrays); actions is echoed from the spec. Shape:
 *   { name, actions: ["CanView"], objects: [{type,uuid?}], subjects: [{type,uuid?}] }
 */
function buildPayload(
  spec: PermissionSpec,
  objects: unknown[],
  subjects: unknown[],
): Record<string, unknown> {
  return {
    name: spec.name,
    actions: spec.actions,
    objects,
    subjects,
  }
}
