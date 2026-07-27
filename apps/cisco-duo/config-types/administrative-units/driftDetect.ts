import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractAdminUnitSpecs, type LiveAdminUnit } from './validate'

const BASE = '/admin/v1/administrative_units'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildDuoClient(cred, settings)

  const specs = extractAdminUnitSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAdminUnit>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((u) => u.name).map((u) => [u.name!.toLowerCase(), u]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const liveDesc = (live.description ?? '') as string
    if (liveDesc !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDesc, severity: 'warning' })
    }
    if ((live.restrict_by_groups === true) !== spec.restrictByGroups) {
      diffs.push({ field: `${spec.name}.restrict_by_groups`, expected: String(spec.restrictByGroups), actual: String(live.restrict_by_groups === true), severity: 'warning' })
    }
    if ((live.restrict_by_integrations === true) !== spec.restrictByIntegrations) {
      diffs.push({ field: `${spec.name}.restrict_by_integrations`, expected: String(spec.restrictByIntegrations), actual: String(live.restrict_by_integrations === true), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
