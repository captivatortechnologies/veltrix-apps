import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { combinationsEqual, extractAuthStrengthSpecs, type LiveAuthStrengthPolicy } from './validate'

const BASE = '/policies/authenticationStrengthPolicies'
const SELECT = '?$select=id,displayName,description,policyType,allowedCombinations'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAuthStrengthSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAuthStrengthPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p])
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
    if (!combinationsEqual(spec.combinations, live.allowedCombinations ?? [])) {
      diffs.push({
        field: `${spec.name}.allowedCombinations`,
        expected: spec.combinations.join(' | '),
        actual: (live.allowedCombinations ?? []).join(' | '),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
