import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { listCustomProfiles } from './deploy'
import { customProfileKey, extractCustomProfileSpecs, indexCustomProfilesByName } from './validate'

/**
 * Detect drift between the deployed Custom Profile configuration and the
 * live Kandji tenant. Re-finds each declared item by name and diffs the
 * managed fields, including the plist payload itself (Kandji's GET returns
 * it back verbatim as `profile`); a missing item is critical drift, a
 * changed field is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCustomProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listCustomProfiles(client)
    const byName = indexCustomProfilesByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(customProfileKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if ((found.active ?? true) !== spec.active) {
        diffs.push({ field: `${label}.active`, expected: spec.active, actual: found.active ?? true, severity: 'warning' })
      }
      if ((found.runs_on_mac ?? true) !== spec.runsOnMac) {
        diffs.push({ field: `${label}.runs_on_mac`, expected: spec.runsOnMac, actual: found.runs_on_mac ?? true, severity: 'warning' })
      }
      if ((found.runs_on_iphone ?? false) !== spec.runsOnIphone) {
        diffs.push({
          field: `${label}.runs_on_iphone`,
          expected: spec.runsOnIphone,
          actual: found.runs_on_iphone ?? false,
          severity: 'warning',
        })
      }
      if ((found.runs_on_ipad ?? false) !== spec.runsOnIpad) {
        diffs.push({ field: `${label}.runs_on_ipad`, expected: spec.runsOnIpad, actual: found.runs_on_ipad ?? false, severity: 'warning' })
      }
      if ((found.runs_on_tv ?? false) !== spec.runsOnTv) {
        diffs.push({ field: `${label}.runs_on_tv`, expected: spec.runsOnTv, actual: found.runs_on_tv ?? false, severity: 'warning' })
      }
      if ((found.profile ?? '') !== spec.profile) {
        diffs.push({ field: `${label}.profile`, expected: 'declared payload', actual: 'different payload', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'kandji',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
