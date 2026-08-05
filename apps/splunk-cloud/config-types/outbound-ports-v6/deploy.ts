import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { normalizeSubnet } from '../../lib/cidr'
import { extractOutboundPortV6Specs } from './validate'

export interface OutboundPortV6RollbackEntry {
  port: number
  /** Subnets this deployment added (rollback removes them). */
  added: string[]
  /** Subnets this deployment removed (rollback restores them). */
  removed: string[]
}

interface LiveOutboundPortV6 {
  port: number
  name?: string
  destinationRanges?: string[]
}

/** GET the live outbound-ports-v6 list, tolerating a bare array or an `outboundPorts` wrapper. */
async function readLivePorts(acs: AcsRequestOptions): Promise<Map<number, string[]>> {
  const res = await acsRequest(acs, 'GET', '/access/outbound-ports-v6')
  if (res.status !== 200) {
    throw new Error(`Failed to read IPv6 outbound ports: ${acsErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveOutboundPortV6[] | { outboundPorts?: LiveOutboundPortV6[] }>(res.body)
  const list = Array.isArray(parsed) ? parsed : (parsed?.outboundPorts ?? [])
  const byPort = new Map<number, string[]>()
  for (const item of list) {
    byPort.set(item.port, (item.destinationRanges ?? []).map(normalizeSubnet))
  }
  return byPort
}

/**
 * Deploy IPv6 outbound port rules to a Splunk Cloud stack via the ACS API.
 *
 * For each declared port the handler reconciles destination subnets:
 *   - GET    /access/outbound-ports-v6 — read live rules
 *   - POST   /access/outbound-ports-v6 — add declared subnets not yet live
 *   - DELETE /access/outbound-ports-v6/{port} — remove undeclared live subnets,
 *     only when removeUndeclared is enabled.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message:
        'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractOutboundPortV6Specs(ctx.canvas).filter((s) => s.port !== null)
  const rollbackState: OutboundPortV6RollbackEntry[] = []
  const summary: string[] = []

  try {
    const live = await readLivePorts(acs)

    for (const spec of specs) {
      const port = spec.port as number
      const liveSubnets = live.get(port) ?? []
      const toAdd = spec.subnets.filter((s) => !liveSubnets.includes(s))
      const toRemove = spec.removeUndeclared
        ? liveSubnets.filter((s) => !spec.subnets.includes(s))
        : []

      if (toAdd.length > 0) {
        const body: Record<string, unknown> = { outboundPorts: [{ port, subnets: toAdd }] }
        if (spec.reason) body.reason = spec.reason
        const res = await acsRequest(acs, 'POST', '/access/outbound-ports-v6', body)
        if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
          throw new Error(`Failed to add IPv6 destinations to port ${port}: ${acsErrorMessage(res)}`)
        }
      }

      if (toRemove.length > 0) {
        const res = await acsRequest(acs, 'DELETE', `/access/outbound-ports-v6/${port}`, {
          subnets: toRemove,
        })
        if (res.status !== 200 && res.status !== 202) {
          throw new Error(`Failed to remove IPv6 destinations from port ${port}: ${acsErrorMessage(res)}`)
        }
      }

      rollbackState.push({ port, added: toAdd, removed: toRemove })
      summary.push(`${port}: +${toAdd.length}/-${toRemove.length}`)
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} IPv6 outbound port rule(s) on stack "${stack}" (${summary.join(', ')})`,
      artifacts: {
        stack,
        experience: settings.experience,
        ports: specs.map((s) => s.port),
        changes: rollbackState,
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `IPv6 outbound port deployment to stack "${stack}" failed after ${rollbackState.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, changes: rollbackState },
      rollbackData: { previousState: rollbackState },
    }
  }
}
