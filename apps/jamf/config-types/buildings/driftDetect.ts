import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listBuildings } from './deploy'
import { buildingKey, extractBuildingSpecs, indexBuildingsByName } from './validate'

const ADDRESS_FIELDS = [
  ['streetAddress1', 'streetAddress1'],
  ['streetAddress2', 'streetAddress2'],
  ['city', 'city'],
  ['stateProvince', 'stateProvince'],
  ['zipPostalCode', 'zipPostalCode'],
  ['country', 'country'],
] as const

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractBuildingSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listBuildings(client, ctx.settings)
    const byName = indexBuildingsByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(buildingKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      for (const [specKey, liveKey] of ADDRESS_FIELDS) {
        const expected = spec[specKey]
        const actual = found[liveKey] ?? ''
        if (expected !== actual) {
          diffs.push({ field: `${label}.${specKey}`, expected: expected || '(empty)', actual: actual || '(empty)', severity: 'warning' })
        }
      }
    }
  } catch (error) {
    diffs.push({
      field: 'jamf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
