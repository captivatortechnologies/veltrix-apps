import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
} from '../../lib/splunkRest'
import {
  ROLE_QUOTA_FIELDS,
  extractRoleSpecs,
  normalizeLiveList,
  type LiveRole,
  type RoleSpec,
} from './validate'

/**
 * Detect drift between the deployed role configuration and the live roles on
 * the stack (GET /services/authorization/roles/<role> on port 8089).
 *
 * Severity policy:
 *  - missing role / REST unreachable ............... critical
 *  - capabilities or inherited roles changed ....... critical (privilege change)
 *  - searchable indexes / search filter changed .... critical when WIDENED
 *                                                    (data exposure), else warning
 *  - default searched indexes, default app ......... warning
 *  - quotas, search time window .................... info
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

  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = (await getEntityContent(
        baseUrl,
        auth,
        `/services/authorization/roles/${encodeURIComponent(spec.name)}`,
        timeoutMs,
      )) as LiveRole | null

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffRole(spec, live))
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

function diffRole(spec: RoleSpec, live: LiveRole): DriftDiff[] {
  const diffs: DriftDiff[] = []

  // Privilege-bearing lists: any change is a privilege change.
  diffs.push(
    ...diffList(spec.name, 'capabilities', spec.capabilities, live.capabilities, 'critical'),
    ...diffList(spec.name, 'importedRoles', spec.importedRoles, live.imported_roles, 'critical'),
  )

  // Searchable indexes: a widened list is a data-exposure change.
  if (spec.srchIndexesAllowed) {
    const expected = [...spec.srchIndexesAllowed].sort()
    const actual = normalizeLiveList(live.srchIndexesAllowed).sort()
    if (!sameList(expected, actual)) {
      const widened = actual.some((i) => !expected.includes(i))
      diffs.push({
        field: `${spec.name}.srchIndexesAllowed`,
        expected,
        actual,
        severity: widened ? 'critical' : 'warning',
      })
    }
  }

  diffs.push(
    ...diffList(
      spec.name,
      'srchIndexesDefault',
      spec.srchIndexesDefault,
      live.srchIndexesDefault,
      'warning',
    ),
  )

  // A removed or relaxed search filter drops row-level access control.
  if (spec.srchFilter !== undefined) {
    const actual = typeof live.srchFilter === 'string' ? live.srchFilter : ''
    if (actual !== spec.srchFilter) {
      diffs.push({
        field: `${spec.name}.srchFilter`,
        expected: spec.srchFilter,
        actual: actual || 'not set',
        severity: actual === '' ? 'critical' : 'warning',
      })
    }
  }

  if (spec.defaultApp !== undefined) {
    const actual = typeof live.defaultApp === 'string' ? live.defaultApp : ''
    if (actual !== spec.defaultApp) {
      diffs.push({
        field: `${spec.name}.defaultApp`,
        expected: spec.defaultApp,
        actual: actual || 'not set',
        severity: 'warning',
      })
    }
  }

  if (spec.srchTimeWin !== undefined && Number(live.srchTimeWin) !== spec.srchTimeWin) {
    diffs.push({
      field: `${spec.name}.srchTimeWin`,
      expected: spec.srchTimeWin,
      actual: live.srchTimeWin ?? 'not set',
      severity: 'info',
    })
  }

  for (const key of ROLE_QUOTA_FIELDS) {
    const expected = spec.quotas[key]
    if (expected === undefined) continue
    const actual = live[key]
    if (Number(actual) !== expected) {
      diffs.push({
        field: `${spec.name}.${key}`,
        expected,
        actual: actual ?? 'not set',
        severity: 'info',
      })
    }
  }

  return diffs
}

function diffList(
  role: string,
  field: string,
  expectedRaw: string[] | undefined,
  actualRaw: unknown,
  severity: DriftDiff['severity'],
): DriftDiff[] {
  if (!expectedRaw) return []
  const expected = [...expectedRaw].sort()
  const actual = normalizeLiveList(actualRaw).sort()
  if (sameList(expected, actual)) return []
  return [{ field: `${role}.${field}`, expected, actual, severity }]
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}
