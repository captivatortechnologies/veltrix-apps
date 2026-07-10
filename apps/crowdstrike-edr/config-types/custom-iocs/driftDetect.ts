import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { findIndicator } from './deploy'
import { extractIocSpecs, type IocSpec, type LiveIndicator } from './validate'

/**
 * Detect drift between the deployed custom IOC configuration and the live
 * tenant state. Looks up each declared indicator and diffs the managed fields.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIocSpecs(ctx.deployedConfig).filter((s) => s.type && s.value)

  for (const spec of specs) {
    const label = `${spec.value} (${spec.type})`
    try {
      const live = await findIndicator(client, spec.type, spec.value)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffIndicator(spec, live))
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffIndicator(spec: IocSpec, live: LiveIndicator): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = `${spec.value}`

  // action decides whether the sensor blocks — the most consequential field
  if (live.action !== spec.action) {
    diffs.push({
      field: `${label}.action`,
      expected: spec.action,
      actual: live.action ?? 'not set',
      severity: 'critical',
    })
  }

  if (live.severity !== spec.severity) {
    diffs.push({
      field: `${label}.severity`,
      expected: spec.severity,
      actual: live.severity ?? 'not set',
      severity: 'warning',
    })
  }

  if (!sameSet(live.platforms ?? [], spec.platforms)) {
    // Fewer platforms than declared means hosts are silently unprotected
    const missingPlatform = spec.platforms.some((p) => !(live.platforms ?? []).includes(p))
    diffs.push({
      field: `${label}.platforms`,
      expected: spec.platforms.join(', '),
      actual: (live.platforms ?? []).join(', ') || 'none',
      severity: missingPlatform ? 'critical' : 'warning',
    })
  }

  const liveGlobal = live.applied_globally === true
  if (liveGlobal !== spec.appliedGlobally) {
    diffs.push({
      field: `${label}.appliedGlobally`,
      expected: spec.appliedGlobally,
      actual: liveGlobal,
      severity: 'critical',
    })
  } else if (!spec.appliedGlobally && !sameSet(live.host_groups ?? [], spec.hostGroups)) {
    diffs.push({
      field: `${label}.hostGroups`,
      expected: spec.hostGroups.join(', '),
      actual: (live.host_groups ?? []).join(', ') || 'none',
      severity: 'warning',
    })
  }

  if (spec.expiration && !sameInstant(live.expiration, spec.expiration)) {
    diffs.push({
      field: `${label}.expiration`,
      expected: spec.expiration,
      actual: live.expiration ?? 'not set',
      severity: 'warning',
    })
  }

  return diffs
}

/** Compare timestamps by instant, tolerating formatting differences. */
function sameInstant(a: string | undefined, b: string): boolean {
  if (!a) return false
  const parsedA = Date.parse(a)
  const parsedB = Date.parse(b)
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return a === b
  return parsedA === parsedB
}
