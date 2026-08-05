import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
} from '../../lib/splunkRest'
import { readAcsSettings, resolveAcsToken, resolveStackName, type AcsRequestOptions } from '../../lib/acs'
import { describeTarget, resolveTargets, withTarget } from '../../lib/acsIdentity'
import { getAcsRole, type AcsRoleResponse } from './acsRoles'
import {
  ROLE_QUOTA_FIELDS,
  extractRoleSpecs,
  normalizeLiveList,
  type LiveRole,
  type RoleSpec,
} from './validate'

/**
 * Detect drift between the deployed role configuration and the live roles on
 * the stack, per role's declared transport (see validate.ts / deploy.ts):
 *
 *   REST: GET /services/authorization/roles/<role> on port 8089 — unchanged.
 *   ACS:  GET /adminconfig/v2/roles/<role>, once per declared search-head
 *         target (or the untargeted default when none are declared) — an ACS
 *         role can legitimately be out of sync on one search head and not
 *         another, so each target's diff is reported separately.
 *
 * Severity policy (identical on both transports):
 *  - missing role / API unreachable ................. critical
 *  - capabilities or inherited roles changed ......... critical (privilege change)
 *  - searchable indexes / search filter changed ...... critical when WIDENED
 *                                                      (data exposure), else warning
 *  - default searched indexes, default app ........... warning
 *  - quotas, search time window ....................... info
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)

  const restSpecs = specs.filter((s) => s.transport === 'rest')
  const acsSpecs = specs.filter((s) => s.transport === 'acs')

  if (restSpecs.length > 0) {
    diffs.push(...(await driftRestRoles(ctx, restSpecs)))
  }
  if (acsSpecs.length > 0) {
    diffs.push(...(await driftAcsRoles(ctx, acsSpecs)))
  }

  return { hasDrift: diffs.length > 0, diffs }
}

// --- REST transport -----------------------------------------------------------

async function driftRestRoles(ctx: DriftContext, specs: RoleSpec[]): Promise<DriftDiff[]> {
  const token = resolveRestToken(ctx.credential)
  if (!token) return [] // Without a token there is nothing to compare against.

  const { timeoutMs } = readRestSettings(ctx.settings)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const diffs: DriftDiff[] = []
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
      diffs.push(...diffRestRole(spec.name, spec, live))
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }
  return diffs
}

function diffRestRole(label: string, spec: RoleSpec, live: LiveRole): DriftDiff[] {
  const diffs: DriftDiff[] = []

  diffs.push(
    ...diffList(label, 'capabilities', spec.capabilities, live.capabilities, 'critical'),
    ...diffList(label, 'importedRoles', spec.importedRoles, live.imported_roles, 'critical'),
  )

  if (spec.srchIndexesAllowed) {
    const expected = [...spec.srchIndexesAllowed].sort()
    const actual = normalizeLiveList(live.srchIndexesAllowed).sort()
    if (!sameList(expected, actual)) {
      const widened = actual.some((i) => !expected.includes(i))
      diffs.push({
        field: `${label}.srchIndexesAllowed`,
        expected,
        actual,
        severity: widened ? 'critical' : 'warning',
      })
    }
  }

  diffs.push(...diffList(label, 'srchIndexesDefault', spec.srchIndexesDefault, live.srchIndexesDefault, 'warning'))
  diffs.push(...diffScalar(label, 'srchFilter', spec.srchFilter, live.srchFilter, true))
  diffs.push(...diffScalar(label, 'defaultApp', spec.defaultApp, live.defaultApp, false))

  if (spec.srchTimeWin !== undefined && Number(live.srchTimeWin) !== spec.srchTimeWin) {
    diffs.push({ field: `${label}.srchTimeWin`, expected: spec.srchTimeWin, actual: live.srchTimeWin ?? 'not set', severity: 'info' })
  }

  for (const key of ROLE_QUOTA_FIELDS) {
    const expected = spec.quotas[key]
    if (expected === undefined) continue
    const actual = live[key]
    if (Number(actual) !== expected) {
      diffs.push({ field: `${label}.${key}`, expected, actual: actual ?? 'not set', severity: 'info' })
    }
  }

  return diffs
}

// --- ACS transport --------------------------------------------------------------

async function driftAcsRoles(ctx: DriftContext, specs: RoleSpec[]): Promise<DriftDiff[]> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) return []

  const settings = readAcsSettings(ctx.settings)
  const baseStack = resolveStackName(ctx.component.hostname)
  const acsBase: AcsRequestOptions = { baseUrl: settings.baseUrl, stack: baseStack, token, timeoutMs: settings.timeoutMs }

  const diffs: DriftDiff[] = []
  for (const spec of specs) {
    const targets = resolveTargets(spec.searchHeadTargets)
    const multiTarget = targets.length > 1 || spec.searchHeadTargets.length > 0
    for (const target of targets) {
      const label = multiTarget ? `${spec.name}[${describeTarget(target)}]` : spec.name
      try {
        const acs = withTarget(acsBase, baseStack, target)
        const live = await getAcsRole(acs, spec.name)
        if (!live) {
          diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
          continue
        }
        diffs.push(...diffAcsRole(label, spec, live))
      } catch (error) {
        diffs.push({
          field: label,
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        })
      }
    }
  }
  return diffs
}

function diffAcsRole(label: string, spec: RoleSpec, live: AcsRoleResponse): DriftDiff[] {
  const diffs: DriftDiff[] = []

  diffs.push(
    ...diffList(label, 'capabilities', spec.capabilities, live.capabilities, 'critical'),
    // ACS does NOT echo `importedRoles` at the top level of a read — the
    // declared names surface nested, under `imported.roles`. See acsRoles.ts.
    ...diffList(label, 'importedRoles', spec.importedRoles, live.imported?.roles, 'critical'),
  )

  if (spec.srchIndexesAllowed) {
    const expected = [...spec.srchIndexesAllowed].sort()
    const actual = normalizeLiveList(live.srchIndexesAllowed).sort()
    if (!sameList(expected, actual)) {
      const widened = actual.some((i) => !expected.includes(i))
      diffs.push({
        field: `${label}.srchIndexesAllowed`,
        expected,
        actual,
        severity: widened ? 'critical' : 'warning',
      })
    }
  }

  diffs.push(...diffList(label, 'srchIndexesDefault', spec.srchIndexesDefault, live.srchIndexesDefault, 'warning'))
  diffs.push(...diffScalar(label, 'srchFilter', spec.srchFilter, live.srchFilter, true))
  diffs.push(...diffScalar(label, 'defaultApp', spec.defaultApp, live.defaultApp, false))

  if (spec.srchTimeWin !== undefined && Number(live.srchTimeWin) !== spec.srchTimeWin) {
    diffs.push({ field: `${label}.srchTimeWin`, expected: spec.srchTimeWin, actual: live.srchTimeWin ?? 'not set', severity: 'info' })
  }

  const acsQuotaValue = (key: (typeof ROLE_QUOTA_FIELDS)[number]): number | undefined =>
    (live as unknown as Record<string, number | undefined>)[key]

  for (const key of ROLE_QUOTA_FIELDS) {
    const expected = spec.quotas[key]
    if (expected === undefined) continue
    const actual = acsQuotaValue(key)
    if (Number(actual) !== expected) {
      diffs.push({ field: `${label}.${key}`, expected, actual: actual ?? 'not set', severity: 'info' })
    }
  }

  return diffs
}

// --- Shared diff helpers --------------------------------------------------------

function diffList(
  label: string,
  field: string,
  expectedRaw: string[] | undefined,
  actualRaw: unknown,
  severity: DriftDiff['severity'],
): DriftDiff[] {
  if (!expectedRaw) return []
  const expected = [...expectedRaw].sort()
  const actual = normalizeLiveList(actualRaw).sort()
  if (sameList(expected, actual)) return []
  return [{ field: `${label}.${field}`, expected, actual, severity }]
}

/** A removed/relaxed value on a security-relevant field (srchFilter) is critical; anything else is a warning. */
function diffScalar(
  label: string,
  field: string,
  expected: string | undefined,
  actualRaw: unknown,
  securitySensitive: boolean,
): DriftDiff[] {
  if (expected === undefined) return []
  const actual = typeof actualRaw === 'string' ? actualRaw : ''
  if (actual === expected) return []
  return [
    {
      field: `${label}.${field}`,
      expected,
      actual: actual || 'not set',
      severity: securitySensitive && actual === '' ? 'critical' : 'warning',
    },
  ]
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}
