import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractFeatureRolloutSpecs, type LiveFeatureRolloutPolicy } from './validate'

const BASE = '/policies/featureRolloutPolicies'
const SELECT = '?$select=id,displayName,feature,isEnabled,isAppliedToOrganization'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractFeatureRolloutSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveFeatureRolloutPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]),
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.isEnabled !== (live.isEnabled === true)) {
      diffs.push({
        field: `${spec.name}.isEnabled`,
        expected: String(spec.isEnabled),
        actual: String(live.isEnabled === true),
        severity: 'warning',
      })
    }
    if (spec.isAppliedToOrganization !== (live.isAppliedToOrganization === true)) {
      diffs.push({
        field: `${spec.name}.isAppliedToOrganization`,
        expected: String(spec.isAppliedToOrganization),
        actual: String(live.isAppliedToOrganization === true),
        severity: 'warning',
      })
    }
    if (spec.feature && live.feature && spec.feature !== live.feature) {
      diffs.push({
        field: `${spec.name}.feature`,
        expected: spec.feature,
        actual: live.feature,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
