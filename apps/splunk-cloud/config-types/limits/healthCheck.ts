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
import { extractLimitSpecs } from './validate'

/** One stanza block from the GET /limits response: { "Stanza": ..., "Values": {...} }. */
interface LiveLimitStanza {
  Stanza: string
  Values?: Record<string, string>
}

/**
 * Health check for limits.conf configuration:
 *   1. The limits list is readable via ACS (also proves token validity)
 *   2. Every declared setting is present with the declared value
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

  const specs = extractLimitSpecs(ctx.canvas).filter((s) => s.stanza && s.setting && s.value !== null)

  const res = await acsRequest(acs, 'GET', '/limits')
  if (res.status !== 200) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_reachable',
          passed: false,
          message: `Could not read limits via ACS: ${acsErrorMessage(res)}`,
        },
      ],
    }
  }
  checks.push({ name: 'acs_reachable', passed: true, message: `ACS reachable for stack "${stack}"` })

  const parsed = parseJson<LiveLimitStanza[]>(res.body) ?? []
  const liveByStanza = new Map<string, Map<string, string>>()
  for (const entry of parsed) {
    const values = new Map<string, string>()
    for (const [name, val] of Object.entries(entry.Values ?? {})) {
      values.set(name, String(val))
    }
    liveByStanza.set(entry.Stanza, values)
  }

  for (const spec of specs) {
    const expected = String(spec.value)
    const live = liveByStanza.get(spec.stanza)?.get(spec.setting)
    checks.push({
      name: `${spec.stanza}.${spec.setting}`,
      passed: live === expected,
      message:
        live === expected
          ? `${spec.stanza}.${spec.setting} is ${expected} as declared`
          : `${spec.stanza}.${spec.setting} is ${live ?? 'missing'} — expected ${expected}`,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 100
  return { healthy: score >= 80, score, checks }
}
