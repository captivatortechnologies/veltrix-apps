import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractIdentityProfileSpecs, type LiveIdentityProfile } from './validate'

const BASE = '/v3/identity-profiles'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractIdentityProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveIdentityProfile>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

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
    if ((live.priority ?? 0) !== spec.priority) {
      diffs.push({ field: `${spec.name}.priority`, expected: String(spec.priority), actual: String(live.priority ?? 0), severity: 'warning' })
    }
    if ((live.authoritativeSource?.id ?? '') !== spec.authoritativeSourceId) {
      diffs.push({ field: `${spec.name}.authoritativeSource`, expected: spec.authoritativeSourceId, actual: live.authoritativeSource?.id ?? '', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
