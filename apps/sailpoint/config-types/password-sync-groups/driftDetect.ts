import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractPasswordSyncGroupSpecs, type LivePasswordSyncGroup } from './validate'

const BASE = '/v3/password-sync-groups'

type Diffs = DriftResult['diffs']

function idSet(ids: string[]): string {
  return [...ids].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractPasswordSyncGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LivePasswordSyncGroup>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((g) => g.name).map((g) => [g.name!.toLowerCase(), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.passwordPolicyId ?? '') !== spec.passwordPolicyId) {
      diffs.push({ field: `${spec.name}.passwordPolicyId`, expected: spec.passwordPolicyId, actual: live.passwordPolicyId ?? '', severity: 'warning' })
    }
    if (idSet(live.sourceIds ?? []) !== idSet(spec.sourceIds)) {
      diffs.push({ field: `${spec.name}.sourceIds`, expected: idSet(spec.sourceIds), actual: idSet(live.sourceIds ?? []), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
