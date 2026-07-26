import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractTagSpecs, type LiveTag } from './validate'

const BASE = '/deviceclassification/tags'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractTagSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveTag>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
