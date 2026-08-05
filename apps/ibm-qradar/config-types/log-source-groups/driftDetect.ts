import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractLogSourceGroupSpecs } from './validate'
import { listGroups } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractLogSourceGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listGroups(client)
  const byName = new Map(live.filter((g) => g.name).map((g) => [String(g.name).toLowerCase(), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const group = byName.get(spec.name.toLowerCase())
    if (!group) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    // The API has no update endpoint, so a description/parent mismatch is
    // reported for visibility only — it cannot be auto-corrected by redeploying.
    if ((group.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: group.description ?? '', severity: 'warning' })
    }
    const expectedParentId = spec.parentName ? byName.get(spec.parentName.toLowerCase())?.id : undefined
    if (spec.parentName && expectedParentId !== undefined && (group.parent_id ?? undefined) !== expectedParentId) {
      diffs.push({ field: `${spec.name}.parentName`, expected: spec.parentName, actual: String(group.parent_id ?? ''), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
