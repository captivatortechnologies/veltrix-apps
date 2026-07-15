import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractNetworkSpecs, type LiveNetwork, type NetworkSpec } from './validate'

export interface NetworkRollbackEntry {
  name: string
  existed: boolean
  uuid?: string
  prior?: Partial<Pick<LiveNetwork, 'name' | 'description' | 'assets_ttl_days'>>
}

/**
 * Deploy networks to a Tenable tenant via the Networks API.
 *
 * A network groups scanners and the assets they discover; the UUID Tenable
 * assigns belongs to the network. For each declared network:
 *   - GET  /networks           — list, then match on the name
 *   - PUT  /networks/{uuid}     — update an existing network (capture prior body)
 *   - POST /networks           — create a missing network (capture new uuid)
 *
 * Identity is the NAME. validate refuses the reserved "default" name and dedupes
 * on the name, so the built-in default network (is_default) is never targeted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractNetworkSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: NetworkRollbackEntry[] = []
  const createdUuids: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findNetworkByName(client, spec.name)

      if (existing && existing.uuid) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          uuid: existing.uuid,
          prior: {
            name: existing.name,
            // Capture an explicit empty so rollback can clear a description the
            // deployment sets on a network that previously had none.
            description: existing.description ?? '',
            assets_ttl_days: existing.assets_ttl_days,
          },
        })

        const res = await client.request('PUT', `/networks/${existing.uuid}`, {
          body: buildUpdatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update network "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/networks', {
          body: buildCreatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create network "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveNetwork>(res.body)
        if (!created?.uuid) {
          throw new Error(`Network "${spec.name}" was created but the API returned no uuid`)
        }
        rollbackState.push({ name: spec.name, existed: false, uuid: created.uuid })
        createdUuids.push(created.uuid)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} network(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedNetworks: deployed },
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network deployment failed after ${deployed.length} of ${specs.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedNetworks: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  }
}

// --- Helpers ---

/**
 * Find a network by its name; null when absent. A plain GET /networks returns
 * the full network list. The name is the logical key — match it exactly (a
 * network with a different-cased name is a DIFFERENT network and must not be
 * adopted). The built-in default network is never matched because validate
 * refuses the reserved "default" name.
 */
export async function findNetworkByName(
  client: TenableClient,
  name: string,
): Promise<LiveNetwork | null> {
  const res = await client.request('GET', '/networks')
  if (!res.ok) {
    throw new Error(`Failed to list networks while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const networks = parseJson<{ networks?: LiveNetwork[] }>(res.body)?.networks ?? []
  return networks.find((n) => n.name === name) ?? null
}

/** Fetch a single network by uuid; null on 404. */
export async function getNetworkByUuid(
  client: TenableClient,
  uuid: string,
): Promise<LiveNetwork | null> {
  const res = await client.request('GET', `/networks/${uuid}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch network ${uuid}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LiveNetwork>(res.body)
}

function buildCreatePayload(spec: NetworkSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: spec.name }
  if (spec.description) payload.description = spec.description
  // assets_ttl_days is optional; omit it to let Tenable apply the tenant default.
  if (spec.assetsTtlDays !== undefined) payload.assets_ttl_days = spec.assetsTtlDays
  return payload
}

function buildUpdatePayload(spec: NetworkSpec): Record<string, unknown> {
  // name is echoed back unchanged (we matched on it) so the record is fully
  // specified; description is always sent so clearing it on the canvas
  // converges the live network (and drift detection agrees about the target).
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
  }
  // Only send a TTL when the canvas sets one — there is no "unset" for the
  // tenant-default TTL, so an absent value leaves the live TTL as-is.
  if (spec.assetsTtlDays !== undefined) payload.assets_ttl_days = spec.assetsTtlDays
  return payload
}
