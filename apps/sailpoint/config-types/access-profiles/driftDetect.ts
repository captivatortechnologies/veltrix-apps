import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractAccessProfileSpecs, type LiveAccessProfile } from './validate'

const BASE = '/v3/access-profiles'

type Diffs = DriftResult['diffs']

function idSet(ids: string[]): string {
  return [...ids].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractAccessProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAccessProfile>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

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
    if ((live.source?.id ?? '') !== spec.sourceId) {
      diffs.push({ field: `${spec.name}.source`, expected: spec.sourceId, actual: live.source?.id ?? '', severity: 'warning' })
    }
    if ((live.enabled ?? false) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(live.enabled ?? false), severity: 'warning' })
    }
    const liveEnts = idSet((live.entitlements ?? []).map((e) => e.id ?? '').filter(Boolean))
    if (liveEnts !== idSet(spec.entitlementIds)) {
      diffs.push({ field: `${spec.name}.entitlements`, expected: idSet(spec.entitlementIds), actual: liveEnts, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
