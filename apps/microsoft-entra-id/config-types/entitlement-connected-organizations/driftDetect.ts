import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractConnectedOrgSpecs, parseArray, type LiveConnectedOrg } from './validate'

const BASE = '/identityGovernance/entitlementManagement/connectedOrganizations'
const SELECT = '?$select=id,displayName,description,state,identitySources'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractConnectedOrgSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveConnectedOrg>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((o) => o.displayName).map((o) => [o.displayName!.toLowerCase(), o]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.state !== (live.state ?? '')) {
      diffs.push({ field: `${spec.name}.state`, expected: spec.state, actual: live.state ?? '', severity: 'warning' })
    }
    if ((spec.description || '') !== (live.description ?? '')) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description || '', actual: live.description ?? '', severity: 'warning' })
    }
    const want = canonical(parseArray(spec.identitySources) ?? [])
    const actual = canonical(live.identitySources ?? [])
    if (want !== actual) {
      diffs.push({ field: `${spec.name}.identitySources`, expected: want, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
