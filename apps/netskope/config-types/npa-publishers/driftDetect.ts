import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractPublisherSpecs, type LivePublisher } from './validate'

const BASE = '/infrastructure/publishers'
const LIST_KEY = 'publishers'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractPublisherSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAllNpa<LivePublisher>(BASE, LIST_KEY)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.publisher_name).map((p) => [p.publisher_name!.toLowerCase(), p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.lbrokerconnect === true) !== spec.lbrokerconnect) {
      diffs.push({ field: `${spec.name}.lbrokerconnect`, expected: String(spec.lbrokerconnect), actual: String(live.lbrokerconnect === true), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
