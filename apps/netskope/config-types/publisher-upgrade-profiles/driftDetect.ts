import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractUpgradeProfileSpecs, type LiveUpgradeProfile } from './validate'

const BASE = '/infrastructure/publisherupgradeprofiles'
const LIST_KEY = 'upgrade_profiles'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractUpgradeProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAllNpa<LiveUpgradeProfile>(BASE, LIST_KEY)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.release_type ?? '') !== spec.releaseType) {
      diffs.push({ field: `${spec.name}.release_type`, expected: spec.releaseType, actual: live.release_type ?? '', severity: 'warning' })
    }
    if ((live.docker_tag ?? '') !== spec.dockerTag) {
      diffs.push({ field: `${spec.name}.docker_tag`, expected: spec.dockerTag, actual: live.docker_tag ?? '', severity: 'warning' })
    }
    if ((live.enabled !== false) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(live.enabled !== false), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
