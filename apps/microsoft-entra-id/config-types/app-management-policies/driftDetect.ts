import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractAppManagementSpecs, parseObject, type LiveAppManagementPolicy } from './validate'

const BASE = '/policies/appManagementPolicies'
const SELECT = '?$select=id,displayName,description,isEnabled,restrictions'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAppManagementSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAppManagementPolicy>(`${BASE}${SELECT}`)
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
    const wantRestrictions = canonical(parseObject(spec.restrictions) ?? {})
    const liveRestrictions = canonical(live.restrictions ?? {})
    if (wantRestrictions !== liveRestrictions) {
      diffs.push({
        field: `${spec.name}.restrictions`,
        expected: wantRestrictions,
        actual: liveRestrictions,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
