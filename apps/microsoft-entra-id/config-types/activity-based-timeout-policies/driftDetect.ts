import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonicalDefinition, extractActivityTimeoutSpecs, type LiveActivityTimeoutPolicy } from './validate'

const BASE = '/policies/activityBasedTimeoutPolicies'
const SELECT = '?$select=id,displayName,definition,isOrganizationDefault'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractActivityTimeoutSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveActivityTimeoutPolicy>(`${BASE}${SELECT}`)
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
    const wantDefinition = canonicalDefinition(spec.definition)
    const liveDefinition = canonicalDefinition((live.definition ?? [])[0] ?? '')
    if (wantDefinition !== liveDefinition) {
      diffs.push({
        field: `${spec.name}.definition`,
        expected: wantDefinition ?? '',
        actual: liveDefinition ?? '',
        severity: 'warning',
      })
    }
    const wantDefault = spec.isOrganizationDefault
    const liveDefault = live.isOrganizationDefault === true
    if (wantDefault !== liveDefault) {
      diffs.push({
        field: `${spec.name}.isOrganizationDefault`,
        expected: String(wantDefault),
        actual: String(liveDefault),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
