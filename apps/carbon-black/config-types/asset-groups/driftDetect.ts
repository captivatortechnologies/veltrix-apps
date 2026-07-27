import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractAssetGroupSpecs, type LiveAssetGroup } from './validate'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const base = client.assetGroupsPath()

  const specs = extractAssetGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(base)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const parsed = parseJson<{ results?: LiveAssetGroup[]; groups?: LiveAssetGroup[] } | LiveAssetGroup[]>(res.body)
  const groups = Array.isArray(parsed) ? parsed : parsed?.results ?? parsed?.groups ?? []
  const liveByName = new Map(groups.filter((g) => g.name).map((g) => [g.name!.toLowerCase(), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    // Dynamic groups re-evaluate asynchronously; don't report field drift while
    // the group is still UPDATING (eventually-consistent).
    if ((live.status ?? '').toUpperCase() === 'UPDATING') continue

    if ((live.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.query ?? '') !== spec.query) {
      diffs.push({ field: `${spec.name}.query`, expected: spec.query, actual: live.query ?? '', severity: 'warning' })
    }
    const livePolicy = live.policy_id === undefined || live.policy_id === null ? '' : String(live.policy_id)
    if (livePolicy !== spec.policyId) {
      diffs.push({ field: `${spec.name}.policy_id`, expected: spec.policyId, actual: livePolicy, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
