import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractCalculatedPropertySpecs } from './validate'
import { listCalculatedProperties } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractCalculatedPropertySpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listCalculatedProperties(client)
  const byName = new Map(live.filter((l) => l.name).map((l) => [String(l.name).toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const prop = byName.get(spec.name.toLowerCase())
    if (!prop) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((prop.operator ?? 'ADD').toUpperCase() !== spec.operator) {
      diffs.push({ field: `${spec.name}.operator`, expected: spec.operator, actual: (prop.operator ?? '').toUpperCase(), severity: 'warning' })
    }
    if ((prop.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(prop.enabled ?? true), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
