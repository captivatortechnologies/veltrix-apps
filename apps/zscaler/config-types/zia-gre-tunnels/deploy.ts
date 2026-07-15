import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractGreTunnelSpecs,
  parseGreObject,
  type GreTunnelSpec,
  type LiveGreTunnel,
} from './validate'

export interface GreTunnelRollbackEntry {
  sourceIp: string
  existed: boolean
  id?: number
  prior?: {
    sourceIp?: string
    comment?: string
    primaryDestVip?: unknown
    secondaryDestVip?: unknown
    withinCountry?: boolean
    ipUnnumbered?: boolean
  }
}

/**
 * Deploy ZIA GRE tunnels via the Zscaler OneAPI.
 *
 * Identity is the SOURCE IP (ZIA has no upsert): list /greTunnels, match by
 * sourceIp, then PUT an existing tunnel or POST a new one. ZIA STAGES every
 * write — nothing takes effect until activation — so this writes all tunnels,
 * then calls activate() ONCE at the end. If activation fails the writes remain
 * staged and rollbackData is returned so the platform can revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractGreTunnelSpecs(ctx.canvas).filter((s) => s.sourceIp)
  const rollbackState: GreTunnelRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listGreTunnels(client)
    const bySourceIp = new Map(existing.filter((t) => t.sourceIp).map((t) => [t.sourceIp as string, t]))

    for (const spec of specs) {
      const live = bySourceIp.get(spec.sourceIp)

      if (live && live.id != null) {
        rollbackState.push({
          sourceIp: spec.sourceIp,
          existed: true,
          id: live.id,
          prior: {
            sourceIp: live.sourceIp,
            comment: live.comment ?? '',
            primaryDestVip: live.primaryDestVip,
            secondaryDestVip: live.secondaryDestVip,
            withinCountry: live.withinCountry,
            ipUnnumbered: live.ipUnnumbered,
          },
        })
        const res = await client.zia('PUT', `/greTunnels/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update GRE tunnel "${spec.sourceIp}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/greTunnels', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create GRE tunnel "${spec.sourceIp}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveGreTunnel>(res.body)
        if (created?.id == null) {
          throw new Error(`GRE tunnel "${spec.sourceIp}" was created but the API returned no id`)
        }
        rollbackState.push({ sourceIp: spec.sourceIp, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.sourceIp)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA GRE tunnel(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedTunnels: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA GRE tunnel(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedTunnels: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `GRE tunnel deployment failed after ${deployed.length} of ${specs.length} tunnel(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedTunnels: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA GRE tunnels; throws on a non-OK response. */
export async function listGreTunnels(client: ZscalerClient): Promise<LiveGreTunnel[]> {
  const res = await client.ziaGetAll<LiveGreTunnel>('/greTunnels')
  if (!res.ok) {
    throw new Error(
      `Failed to list GRE tunnels: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a GRE tunnel by source IP; null when absent. */
export async function findGreTunnel(client: ZscalerClient, sourceIp: string): Promise<LiveGreTunnel | null> {
  const all = await listGreTunnels(client)
  return all.find((t) => t.sourceIp === sourceIp) ?? null
}

function buildPayload(spec: GreTunnelSpec): Record<string, unknown> {
  const gre = parseGreObject(spec.greJson)
  const greFields = gre.value ?? {}
  // sourceIp + comment come first; the advanced-tunnel JSON keys are merged on
  // top for fields like primaryDestVip/withinCountry. comment always sent (even
  // empty) so clearing it converges the live tunnel.
  return { sourceIp: spec.sourceIp, comment: spec.comment ?? '', ...greFields }
}
