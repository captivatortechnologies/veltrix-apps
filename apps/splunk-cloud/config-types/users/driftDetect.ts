import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
} from '../../lib/splunkRest'
import { extractUserSpecs, normalizeLiveList, type LiveUser, type UserSpec } from './validate'

/**
 * Detect drift between the deployed user configuration and the live users on
 * the stack (GET /services/authentication/users/<user> on port 8089).
 *
 * Severity policy:
 *  - missing user / REST unreachable ............... critical
 *  - roles changed ................................. critical (privilege change)
 *  - email, default app ............................ warning
 *  - real name, timezone ........................... info
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveRestToken(ctx.credential)
  if (!token) {
    // Without a token there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = (await getEntityContent(
        baseUrl,
        auth,
        `/services/authentication/users/${encodeURIComponent(spec.name)}`,
        timeoutMs,
      )) as LiveUser | null

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffUser(spec, live))
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffUser(spec: UserSpec, live: LiveUser): DriftDiff[] {
  const diffs: DriftDiff[] = []

  // Role assignment is a privilege change — any difference is critical.
  if (spec.roles.length > 0) {
    const expected = [...spec.roles].sort()
    const actual = normalizeLiveList(live.roles).sort()
    if (!sameList(expected, actual)) {
      diffs.push({ field: `${spec.name}.roles`, expected, actual, severity: 'critical' })
    }
  }

  diffs.push(...diffScalar(spec.name, 'email', spec.email, live.email, 'warning'))
  diffs.push(...diffScalar(spec.name, 'defaultApp', spec.defaultApp, live.defaultApp, 'warning'))
  diffs.push(...diffScalar(spec.name, 'realname', spec.realName, live.realname, 'info'))
  diffs.push(...diffScalar(spec.name, 'tz', spec.tz, live.tz, 'info'))

  return diffs
}

function diffScalar(
  user: string,
  field: string,
  expected: string | undefined,
  actualRaw: unknown,
  severity: DriftDiff['severity'],
): DriftDiff[] {
  if (expected === undefined) return []
  const actual = typeof actualRaw === 'string' ? actualRaw : ''
  if (actual === expected) return []
  return [{ field: `${user}.${field}`, expected, actual: actual || 'not set', severity }]
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}
