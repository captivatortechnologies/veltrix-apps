import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
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
import { extractOutboundPortSpecs } from './validate'

interface LiveOutboundPort {
  port: number
  destinationRanges?: string[]
}

/**
 * Health check for outbound port configuration:
 *   1. The outbound-ports list is readable via ACS (also proves token validity)
 *   2. Every declared port rule exists with all its declared destinations
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_token',
          passed: false,
          message: 'No ACS token — store the Splunk Cloud JWT in the credential "API token" field',
        },
      ],
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

  const specs = extractOutboundPortSpecs(ctx.canvas).filter((s) => s.port !== null)

  const res = await acsRequest(acs, 'GET', '/access/outbound-ports')
  if (res.status !== 200) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_reachable',
          passed: false,
          message: `Could not read outbound ports via ACS: ${acsErrorMessage(res)}`,
        },
      ],
    }
  }
  checks.push({ name: 'acs_reachable', passed: true, message: `ACS reachable for stack "${stack}"` })

  const parsed = parseJson<LiveOutboundPort[] | { outboundPorts?: LiveOutboundPort[] }>(res.body)
  const list = Array.isArray(parsed) ? parsed : (parsed?.outboundPorts ?? [])
  const liveByPort = new Map<number, string[]>()
  for (const item of list) {
    liveByPort.set(item.port, (item.destinationRanges ?? []).map(normalizeSubnet))
  }

  for (const spec of specs) {
    const port = spec.port as number
    const live = liveByPort.get(port) ?? []
    const missing = spec.subnets.filter((s) => !live.includes(s))
    checks.push({
      name: `port_${port}`,
      passed: missing.length === 0,
      message:
        missing.length === 0
          ? `Port ${port}: all ${spec.subnets.length} destination(s) present`
          : `Port ${port}: missing ${missing.length} destination(s): ${missing.join(', ')}`,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 100
  return { healthy: score >= 80, score, checks }
}
