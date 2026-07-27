import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAccessPackageSpecs, type LiveAccessPackage } from './validate'

const BASE = '/identityGovernance/entitlementManagement/accessPackages'
const SELECT = '?$select=id,displayName,description,isHidden'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAccessPackageSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAccessPackage>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((spec.description || '') !== (live.description ?? '')) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description || '', actual: live.description ?? '', severity: 'warning' })
    }
    if (spec.isHidden !== (live.isHidden === true)) {
      diffs.push({ field: `${spec.name}.isHidden`, expected: String(spec.isHidden), actual: String(live.isHidden === true), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
