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
import { extractLimitSpecs } from './validate'

/** One stanza block from the GET /limits response: { "Stanza": ..., "Values": {...} }. */
interface LiveLimitStanza {
  Stanza: string
  Values?: Record<string, string>
}

/**
 * Detect drift between the deployed limits.conf settings and live ACS state.
 * A declared setting whose live value differs (or is missing) from the deployed
 * value is critical drift.
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

  const specs = extractLimitSpecs(ctx.deployedConfig).filter((s) => s.stanza && s.setting && s.value !== null)

  try {
    const res = await acsRequest(acs, 'GET', '/limits')
    if (res.status !== 200) {
      return {
        hasDrift: true,
        diffs: [
          { field: 'limits', expected: 'readable', actual: `ACS returned HTTP ${res.status}: ${acsErrorMessage(res)}`, severity: 'critical' },
        ],
      }
    }
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
      if (live === undefined) {
        diffs.push({ field: `${spec.stanza}.${spec.setting}`, expected, actual: 'missing', severity: 'critical' })
      } else if (live !== expected) {
        diffs.push({ field: `${spec.stanza}.${spec.setting}`, expected, actual: live, severity: 'critical' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'limits',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
