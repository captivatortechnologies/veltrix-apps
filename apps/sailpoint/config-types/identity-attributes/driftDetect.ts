import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractIdentityAttributeSpecs, type LiveIdentityAttribute } from './validate'

const BASE = '/beta/identity-attributes'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractIdentityAttributeSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveIdentityAttribute>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.displayName ?? '') !== spec.displayName) {
      diffs.push({ field: `${spec.name}.displayName`, expected: spec.displayName, actual: live.displayName ?? '', severity: 'warning' })
    }
    if ((live.multi ?? false) !== spec.multi) {
      diffs.push({ field: `${spec.name}.multi`, expected: String(spec.multi), actual: String(live.multi ?? false), severity: 'warning' })
    }
    if ((live.searchable ?? false) !== spec.searchable) {
      diffs.push({ field: `${spec.name}.searchable`, expected: String(spec.searchable), actual: String(live.searchable ?? false), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
