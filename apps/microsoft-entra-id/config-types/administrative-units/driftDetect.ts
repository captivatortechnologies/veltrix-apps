import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAdministrativeUnitSpecs, graphVisibility, type LiveAdministrativeUnit } from './validate'

const BASE = '/directory/administrativeUnits'
const SELECT = '?$select=id,displayName,description,visibility,membershipType'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAdministrativeUnitSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAdministrativeUnit>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((u) => u.displayName).map((u) => [u.displayName!.toLowerCase(), u])
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const wantDescription = spec.description || ''
    const liveDescription = (live.description ?? '') as string
    if (liveDescription !== wantDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: wantDescription,
        actual: liveDescription,
        severity: 'warning',
      })
    }
    const wantVisibility = graphVisibility(spec) ?? 'public'
    const liveVisibility = (live.visibility ?? 'public') as string
    if (liveVisibility !== wantVisibility) {
      diffs.push({
        field: `${spec.name}.visibility`,
        expected: wantVisibility,
        actual: liveVisibility,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
