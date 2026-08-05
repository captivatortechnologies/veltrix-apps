import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
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

interface LiveOutboundPortV6 {
  port: number
  destinationRanges?: string[]
}

/**
 * Detect drift between the deployed IPv6 outbound port rules and live ACS
 * state. Declared destinations missing from the live rule are critical; live
 * destinations not declared are warnings when the rule is reconciled
 * (removeUndeclared) and informational otherwise.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return { hasDrift: false, diffs: [] }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractOutboundPortV6Specs(ctx.deployedConfig).filter((s) => s.port !== null)

  try {
    const res = await acsRequest(acs, 'GET', '/access/outbound-ports-v6')
    if (res.status !== 200) {
      return {
        hasDrift: true,
        diffs: [
          { field: 'outbound-ports-v6', expected: 'readable', actual: `ACS returned HTTP ${res.status}: ${acsErrorMessage(res)}`, severity: 'critical' },
        ],
      }
    }
    const parsed = parseJson<LiveOutboundPortV6[] | { outboundPorts?: LiveOutboundPortV6[] }>(res.body)
    const list = Array.isArray(parsed) ? parsed : (parsed?.outboundPorts ?? [])
    const liveByPort = new Map<number, string[]>()
    for (const item of list) {
      liveByPort.set(item.port, (item.destinationRanges ?? []).map(normalizeSubnet))
    }

    for (const spec of specs) {
      const port = spec.port as number
      const live = liveByPort.get(port) ?? []

      for (const subnet of spec.subnets) {
        if (!live.includes(subnet)) {
          diffs.push({ field: `${port}.subnets`, expected: subnet, actual: 'missing', severity: 'critical' })
        }
      }
      for (const subnet of live) {
        if (!spec.subnets.includes(subnet)) {
          diffs.push({
            field: `${port}.subnets`,
            expected: 'not declared',
            actual: subnet,
            severity: spec.removeUndeclared ? 'warning' : 'info',
          })
        }
      }
    }
  } catch (error) {
    diffs.push({
      field: 'outbound-ports-v6',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
