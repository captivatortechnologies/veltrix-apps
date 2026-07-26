import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  readGraphSettings,
  resolveGraphCredential,
} from '../../lib/graph'
import { extractNamedLocationSpecs, type LiveNamedLocation } from './validate'

const BASE = '/identity/conditionalAccess/namedLocations'

type Diffs = DriftResult['diffs']

function sortedJson(v: unknown[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift
  // rather than a false positive.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractNamedLocationSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveNamedLocation>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((l) => l.displayName).map((l) => [l.displayName!.toLowerCase(), l])
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.type === 'ip') {
      if ((live.isTrusted ?? false) !== spec.isTrusted) {
        diffs.push({
          field: `${spec.name}.isTrusted`,
          expected: spec.isTrusted,
          actual: live.isTrusted ?? false,
          severity: 'warning',
        })
      }
      const liveCidrs = (live.ipRanges ?? []).map((r) => r.cidrAddress).filter(Boolean) as string[]
      if (sortedJson(liveCidrs) !== sortedJson(spec.ipRanges)) {
        diffs.push({
          field: `${spec.name}.ipRanges`,
          expected: [...spec.ipRanges].sort(),
          actual: [...liveCidrs].sort(),
          severity: 'warning',
        })
      }
    } else {
      const liveCountries = live.countriesAndRegions ?? []
      if (sortedJson(liveCountries) !== sortedJson(spec.countries)) {
        diffs.push({
          field: `${spec.name}.countries`,
          expected: [...spec.countries].sort(),
          actual: [...liveCountries].sort(),
          severity: 'warning',
        })
      }
      if ((live.includeUnknownCountriesAndRegions ?? false) !== spec.includeUnknown) {
        diffs.push({
          field: `${spec.name}.includeUnknown`,
          expected: spec.includeUnknown,
          actual: live.includeUnknownCountriesAndRegions ?? false,
          severity: 'info',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
