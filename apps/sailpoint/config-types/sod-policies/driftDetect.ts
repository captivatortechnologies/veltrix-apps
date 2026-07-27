import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractSodPolicySpecs, type LiveSodPolicy } from './validate'

const BASE = '/v3/sod-policies'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractSodPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveSodPolicy>(BASE)
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
    if ((live.state ?? '') !== spec.state) {
      diffs.push({ field: `${spec.name}.state`, expected: spec.state, actual: live.state ?? '', severity: 'warning' })
    }
    if ((live.ownerRef?.id ?? '') !== spec.ownerId) {
      diffs.push({ field: `${spec.name}.owner`, expected: spec.ownerId, actual: live.ownerRef?.id ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
