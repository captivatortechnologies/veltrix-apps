import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractRequirementSpecs, type LiveRequirement } from './validate'
import type { LiveStandard } from '../compliance-standards/validate'

const COMPLIANCE = '/compliance'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractRequirementSpecs(ctx.deployedConfig).filter((s) => s.standardName && s.requirementId)
  const stdRes = await client.get(COMPLIANCE)
  if (!stdRes.ok) return { hasDrift: false, diffs: [] }
  const standardByName = new Map(
    (parseJson<LiveStandard[]>(stdRes.body) ?? []).filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s])
  )

  const reqCache = new Map<string, Map<string, LiveRequirement>>()
  async function reqsFor(complianceId: string): Promise<Map<string, LiveRequirement> | null> {
    const cached = reqCache.get(complianceId)
    if (cached) return cached
    const res = await client.get(`${COMPLIANCE}/${complianceId}/requirement`)
    if (!res.ok) return null
    const map = new Map<string, LiveRequirement>()
    for (const r of parseJson<LiveRequirement[]>(res.body) ?? []) if (r.requirementId) map.set(r.requirementId.toLowerCase(), r)
    reqCache.set(complianceId, map)
    return map
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const standard = standardByName.get(spec.standardName.toLowerCase())
    if (!standard?.id) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}`, expected: 'present', actual: 'standard absent', severity: 'critical' })
      continue
    }
    const reqs = await reqsFor(standard.id)
    if (!reqs) continue
    const live = reqs.get(spec.requirementId.toLowerCase())
    if (!live) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.name ?? '') !== spec.name) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}.name`, expected: spec.name, actual: live.name ?? '', severity: 'warning' })
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}.description`, expected: spec.description, actual: (live.description ?? '') as string, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
