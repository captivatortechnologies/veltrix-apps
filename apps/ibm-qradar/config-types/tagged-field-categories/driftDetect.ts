import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractTaggedFieldCategorySpecs } from './validate'
import { listCategories } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractTaggedFieldCategorySpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listCategories(client)
  const byName = new Set(live.filter((c) => c.name).map((c) => String(c.name).toLowerCase()))

  const diffs: Diffs = []
  for (const spec of specs) {
    if (!byName.has(spec.name.toLowerCase())) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
