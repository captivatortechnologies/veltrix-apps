import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  qualysReturnId,
  qualysWriteError,
  xmlText,
  type QualysClient,
} from '../../lib/qualys'
import { extractNetworkSpecs, networkKey, type LiveNetwork, type NetworkSpec } from './validate'

export const NETWORK_PATH = '/api/2.0/fo/network/'

export interface NetworkRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveNetwork
}

/**
 * Deploy Qualys custom networks via the classic v2 API.
 *
 * Identity is the name natural key: list networks, match on the name, then
 * rename an existing network or create a new one. Networks have no delete API —
 * see rollback.ts for the resulting best-effort limitation on created networks.
 * Only available when the subscription's Network Support feature is enabled.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractNetworkSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: NetworkRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listNetworks(client)
    const byKey = new Map(existing.map((n) => [networkKey(n), n]))

    for (const spec of specs) {
      const label = spec.name
      const key = networkKey(spec)
      const live = byKey.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.post(NETWORK_PATH, { action: 'update', id: live.id, name: spec.name })
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to rename network "${label}": ${failed}`)
      } else {
        const res = await client.post(NETWORK_PATH, { action: 'create', name: spec.name })
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to create network "${label}": ${failed}`)
        const newId = qualysReturnId(res.body)
        if (!newId) throw new Error(`Network "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: newId })
        createdIds.push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} network(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedNetworks: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedNetworks: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all custom networks; throws on a non-OK response. */
export async function listNetworks(client: QualysClient): Promise<LiveNetwork[]> {
  const res = await client.list(NETWORK_PATH, {}, 'NETWORK')
  if (!res.ok) {
    throw new Error(`Failed to list networks: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.blocks.map(parseNetworkBlock).filter((n) => n.id && n.name)
}

/** Parse one `<NETWORK>` block into a LiveNetwork. */
export function parseNetworkBlock(block: string): LiveNetwork {
  return {
    id: xmlText(block, 'ID'),
    name: xmlText(block, 'NAME'),
  }
}

export function buildCreateParams(spec: NetworkSpec) {
  return { action: 'create' as const, name: spec.name }
}

export function buildUpdateParams(spec: NetworkSpec, id: string) {
  return { action: 'update' as const, id, name: spec.name }
}
