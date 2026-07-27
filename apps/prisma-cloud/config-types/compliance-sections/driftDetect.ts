import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractSectionSpecs, type LiveSection } from './validate'
import type { LiveStandard } from '../compliance-standards/validate'
import type { LiveRequirement } from '../compliance-requirements/validate'

const COMPLIANCE = '/compliance'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractSectionSpecs(ctx.deployedConfig).filter((s) => s.standardName && s.requirementId && s.sectionId)
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

  const sectionCache = new Map<string, Map<string, LiveSection>>()
  async function sectionsFor(requirementFlatId: string): Promise<Map<string, LiveSection> | null> {
    const cached = sectionCache.get(requirementFlatId)
    if (cached) return cached
    const res = await client.get(`${COMPLIANCE}/${requirementFlatId}/section`)
    if (!res.ok) return null
    const map = new Map<string, LiveSection>()
    for (const s of parseJson<LiveSection[]>(res.body) ?? []) if (s.sectionId) map.set(s.sectionId.toLowerCase(), s)
    sectionCache.set(requirementFlatId, map)
    return map
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const standard = standardByName.get(spec.standardName.toLowerCase())
    if (!standard?.id) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}/${spec.sectionId}`, expected: 'present', actual: 'standard absent', severity: 'critical' })
      continue
    }
    const reqs = await reqsFor(standard.id)
    if (!reqs) continue
    const requirement = reqs.get(spec.requirementId.toLowerCase())
    if (!requirement?.id) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}/${spec.sectionId}`, expected: 'present', actual: 'requirement absent', severity: 'critical' })
      continue
    }
    const sections = await sectionsFor(requirement.id)
    if (!sections) continue
    const live = sections.get(spec.sectionId.toLowerCase())
    if (!live) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}/${spec.sectionId}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.standardName}/${spec.requirementId}/${spec.sectionId}.description`, expected: spec.description, actual: (live.description ?? '') as string, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
