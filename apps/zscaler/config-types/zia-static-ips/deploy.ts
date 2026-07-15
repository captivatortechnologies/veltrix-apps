import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractStaticIpSpecs, type StaticIpSpec, type LiveStaticIp } from './validate'

export interface StaticIpRollbackEntry {
  ipAddress: string
  existed: boolean
  id?: number
  prior?: {
    ipAddress?: string
    comment?: string
    geoOverride?: boolean
    latitude?: number
    longitude?: number
    routableIP?: boolean
  }
}

/**
 * Deploy ZIA static IPs via the Zscaler OneAPI.
 *
 * Identity is the IP ADDRESS (ZIA has no upsert): list /staticIP, match by
 * ipAddress, then PUT an existing static IP or POST a new one. ZIA STAGES every
 * write — nothing takes effect until activation — so this writes all static IPs,
 * then calls activate() ONCE at the end. If activation fails the writes remain
 * staged and rollbackData is returned so the platform can revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractStaticIpSpecs(ctx.canvas).filter((s) => s.ipAddress)
  const rollbackState: StaticIpRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listStaticIps(client)
    const byIp = new Map(existing.filter((s) => s.ipAddress).map((s) => [s.ipAddress as string, s]))

    for (const spec of specs) {
      const live = byIp.get(spec.ipAddress)

      if (live && live.id != null) {
        rollbackState.push({
          ipAddress: spec.ipAddress,
          existed: true,
          id: live.id,
          prior: {
            ipAddress: live.ipAddress,
            comment: live.comment ?? '',
            geoOverride: live.geoOverride === true,
            latitude: live.latitude,
            longitude: live.longitude,
            routableIP: live.routableIP !== false,
          },
        })
        const res = await client.zia('PUT', `/staticIP/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update static IP "${spec.ipAddress}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/staticIP', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create static IP "${spec.ipAddress}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveStaticIp>(res.body)
        if (created?.id == null) {
          throw new Error(`Static IP "${spec.ipAddress}" was created but the API returned no id`)
        }
        rollbackState.push({ ipAddress: spec.ipAddress, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.ipAddress)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA static IP(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedStaticIps: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA static IP(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedStaticIps: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Static IP deployment failed after ${deployed.length} of ${specs.length} static IP(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedStaticIps: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA static IPs; throws on a non-OK response. */
export async function listStaticIps(client: ZscalerClient): Promise<LiveStaticIp[]> {
  const res = await client.ziaGetAll<LiveStaticIp>('/staticIP')
  if (!res.ok) {
    throw new Error(
      `Failed to list static IPs: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a static IP by its IP address; null when absent. */
export async function findStaticIp(client: ZscalerClient, ipAddress: string): Promise<LiveStaticIp | null> {
  const all = await listStaticIps(client)
  return all.find((s) => s.ipAddress === ipAddress) ?? null
}

function buildPayload(spec: StaticIpSpec): Record<string, unknown> {
  // comment always sent (even empty) so clearing it converges the live static IP.
  const body: Record<string, unknown> = {
    ipAddress: spec.ipAddress,
    comment: spec.comment ?? '',
    geoOverride: spec.geoOverride,
    routableIP: spec.routableIp,
  }
  // ZIA derives lat/long from the IP unless geoOverride is set; only send manual
  // coordinates when overriding (validate guarantees both are present then).
  if (spec.geoOverride) {
    if (spec.latitude !== undefined) body.latitude = spec.latitude
    if (spec.longitude !== undefined) body.longitude = spec.longitude
  }
  return body
}
