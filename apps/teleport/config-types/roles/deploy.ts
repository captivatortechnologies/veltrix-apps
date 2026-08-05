import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, parseJson, teleportErrorMessage, type TeleportClient } from '../../lib/teleport'
import { extractRoleSpecs, buildRoleYaml, type RoleSpec } from './validate'

export interface RoleRollbackEntry {
  name: string
  existed: boolean
  /** The prior full resource YAML, captured for roles this deploy UPDATED. */
  priorContent?: string
}

interface RoleResourceItem {
  content?: string
}

/** Read a single role by name; null on 404 (absent). Shared by deploy, healthCheck and driftDetect. */
export async function getRole(client: TeleportClient, name: string): Promise<RoleResourceItem | null> {
  const res = await client.request('GET', `/v1/webapi/roles/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read role "${name}": ${teleportErrorMessage(res)}`)
  }
  return parseJson<RoleResourceItem>(res.body)
}

/**
 * Deploy RBAC roles via the Teleport Proxy web API (lib/web/resources.go):
 *   - POST /v1/webapi/roles          — create (kind mismatch / already-exists rejected server-side)
 *   - PUT  /v1/webapi/roles/{name}   — update an existing role
 * Both send `{"content": "<full role YAML>"}`. Identity is the NAME.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name && s.spec)
  const rollbackState: RoleRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getRole(client, spec.name)
      const content = buildRoleYaml(spec)

      if (existing) {
        rollbackState.push({ name: spec.name, existed: true, priorContent: existing.content ?? '' })
        const res = await client.request('PUT', `/v1/webapi/roles/${encodeURIComponent(spec.name)}`, {
          body: { content },
        })
        if (!res.ok) throw new Error(`Failed to update role "${spec.name}": ${teleportErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.request('POST', '/v1/webapi/roles', { body: { content } })
        if (!res.ok) throw new Error(`Failed to create role "${spec.name}": ${teleportErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} role(s) to Teleport at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

export type { RoleSpec }
