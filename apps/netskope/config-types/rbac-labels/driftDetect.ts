import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractLabelSpecs, type LiveLabel } from './validate'

const BASE = '/rbac/labels'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractLabelSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveLabel>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.color && ((live.color ?? '') as string).toLowerCase() !== spec.color.toLowerCase()) {
      diffs.push({ field: `${spec.name}.color`, expected: spec.color, actual: live.color ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
