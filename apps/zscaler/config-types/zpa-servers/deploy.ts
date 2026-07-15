import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractServerSpecs, type LiveServer, type ServerSpec } from './validate'

export interface ServerRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: { name?: string; description?: string; address?: string; enabled?: boolean }
}

/**
 * Deploy ZPA servers via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZPA has no upsert): list /server, match by name, then
 * PUT an existing server or POST a new one. Unlike ZIA, ZPA changes apply
 * IMMEDIATELY — there is no activation step, so a write returning success is the
 * end of the operation.
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

  const specs = extractServerSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServerRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listServers(client)
    const byName = new Map(existing.filter((s) => s.name).map((s) => [s.name as string, s]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            address: live.address ?? '',
            enabled: live.enabled ?? true,
          },
        })
        const res = await client.zpa('PUT', `/server/${live.id}`, { body: buildPayload(spec, live.id) })
        if (!res.ok) {
          throw new Error(`Failed to update server "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', '/server', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create server "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveServer>(res.body)
        if (created?.id == null) {
          throw new Error(`Server "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA server(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedServers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Server deployment failed after ${deployed.length} of ${specs.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedServers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZPA servers; throws on a non-OK response. */
export async function listServers(client: ZscalerClient): Promise<LiveServer[]> {
  const res = await client.zpaGetAll<LiveServer>('/server')
  if (!res.ok) {
    throw new Error(`Failed to list servers: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

function buildPayload(spec: ServerSpec, id?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    address: spec.address,
    enabled: spec.enabled,
  }
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (id != null) payload.id = id
  return payload
}
