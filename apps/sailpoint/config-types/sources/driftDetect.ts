import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractSourceSpecs, type LiveSource } from './validate'

const BASE = '/v3/sources'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractSourceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveSource>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

  // connectorAttributes carry connector secrets that GET masks, so they are not drift-tracked.
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
    if ((live.owner?.id ?? '') !== spec.ownerId) {
      diffs.push({ field: `${spec.name}.owner`, expected: spec.ownerId, actual: live.owner?.id ?? '', severity: 'warning' })
    }
    if (spec.deleteThreshold > 0 && (live.deleteThreshold ?? 0) !== spec.deleteThreshold) {
      diffs.push({ field: `${spec.name}.deleteThreshold`, expected: String(spec.deleteThreshold), actual: String(live.deleteThreshold ?? 0), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
