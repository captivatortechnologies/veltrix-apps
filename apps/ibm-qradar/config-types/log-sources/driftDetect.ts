import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractLogSourceSpecs } from './validate'
import { listLogSources } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractLogSourceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listLogSources(client)
  const byName = new Map(live.filter((l) => l.name).map((l) => [String(l.name).toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const ls = byName.get(spec.name.toLowerCase())
    if (!ls) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((ls.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(ls.enabled ?? true), severity: 'warning' })
    }
    if ((ls.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: ls.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
