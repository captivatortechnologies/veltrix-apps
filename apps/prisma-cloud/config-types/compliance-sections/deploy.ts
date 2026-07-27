import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type PcClient,
} from '../../lib/prismacloud'
import { extractSectionSpecs, type LiveSection, type SectionSpec } from './validate'
import type { LiveStandard } from '../compliance-standards/validate'
import type { LiveRequirement } from '../compliance-requirements/validate'

const COMPLIANCE = '/compliance'

export interface RollbackEntry {
  itemId?: string
  standardName: string
  requirementId: string
  /** The parent requirement's own id (sections are listed/created under it). */
  requirementFlatId?: string
  sectionId: string
  /** Whether the section existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The section's own id (flat-addressed for update/delete). */
  id?: string
  prior?: { sectionId: string; description: string; viewOrder?: number }
}

export function sectionBody(spec: SectionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { sectionId: spec.sectionId, description: spec.description }
  if (spec.viewOrder !== undefined) body.viewOrder = spec.viewOrder
  return body
}

async function listStandards(client: PcClient): Promise<LiveStandard[] | null> {
  const res = await client.get(COMPLIANCE)
  if (!res.ok) return null
  return parseJson<LiveStandard[]>(res.body) ?? []
}

async function listRequirements(client: PcClient, complianceId: string): Promise<LiveRequirement[] | null> {
  const res = await client.get(`${COMPLIANCE}/${complianceId}/requirement`)
  if (!res.ok) return null
  return parseJson<LiveRequirement[]>(res.body) ?? []
}

async function listSections(client: PcClient, requirementFlatId: string): Promise<LiveSection[] | null> {
  const res = await client.get(`${COMPLIANCE}/${requirementFlatId}/section`)
  if (!res.ok) return null
  return parseJson<LiveSection[]>(res.body) ?? []
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractSectionSpecs(ctx.canvas).filter((s) => s.standardName && s.requirementId && s.sectionId)

  const standards = await listStandards(client)
  if (!standards) return { success: false, message: 'Failed to list compliance standards' }
  const standardByName = new Map<string, LiveStandard>()
  for (const s of standards) if (s.name) standardByName.set(s.name.toLowerCase(), s)

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const reqByStandard = new Map<string, Map<string, LiveRequirement>>()
  const sectionsByRequirement = new Map<string, Map<string, LiveSection>>()
  const createdInRequirement = new Set<string>()

  async function requirementsFor(complianceId: string): Promise<Map<string, LiveRequirement> | null> {
    const cached = reqByStandard.get(complianceId)
    if (cached) return cached
    const list = await listRequirements(client, complianceId)
    if (!list) return null
    const map = new Map<string, LiveRequirement>()
    for (const r of list) if (r.requirementId) map.set(r.requirementId.toLowerCase(), r)
    reqByStandard.set(complianceId, map)
    return map
  }

  async function sectionsFor(requirementFlatId: string): Promise<Map<string, LiveSection> | null> {
    const cached = sectionsByRequirement.get(requirementFlatId)
    if (cached) return cached
    const list = await listSections(client, requirementFlatId)
    if (!list) return null
    const map = new Map<string, LiveSection>()
    for (const s of list) if (s.sectionId) map.set(s.sectionId.toLowerCase(), s)
    sectionsByRequirement.set(requirementFlatId, map)
    return map
  }

  for (const spec of specs) {
    const standard = standardByName.get(spec.standardName.toLowerCase())
    if (!standard?.id) {
      failures.push(`${spec.sectionId}: parent standard "${spec.standardName}" not found — declare it on the Compliance Standards canvas first`)
      continue
    }
    if (standard.systemDefault) {
      failures.push(`${spec.sectionId}: standard "${spec.standardName}" is a built-in standard and cannot take custom sections`)
      continue
    }

    const reqs = await requirementsFor(standard.id)
    if (!reqs) {
      failures.push(`${spec.sectionId}: failed to list requirements for "${spec.standardName}"`)
      continue
    }
    const requirement = reqs.get(spec.requirementId.toLowerCase())
    if (!requirement?.id) {
      failures.push(`${spec.sectionId}: parent requirement "${spec.requirementId}" not found in "${spec.standardName}" — declare it on the Compliance Requirements canvas first`)
      continue
    }
    if (requirement.systemDefault) {
      failures.push(`${spec.sectionId}: requirement "${spec.requirementId}" is built-in and cannot take custom sections`)
      continue
    }

    const live = await sectionsFor(requirement.id)
    if (!live) {
      failures.push(`${spec.sectionId}: failed to list sections for "${spec.standardName}/${spec.requirementId}"`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const match = live.get(spec.sectionId.toLowerCase())

    if (match?.id) {
      if (match.systemDefault) {
        failures.push(`${spec.standardName}/${spec.requirementId}/${spec.sectionId}: a built-in section with this id exists and will not be modified`)
        continue
      }
      const resp = await client.put(`${COMPLIANCE}/requirement/section/${match.id}`, sectionBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.standardName}/${spec.requirementId}/${spec.sectionId}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        standardName: spec.standardName,
        requirementId: spec.requirementId,
        requirementFlatId: requirement.id,
        sectionId: spec.sectionId,
        existed: true,
        id: match.id,
        prior: { sectionId: match.sectionId ?? '', description: (match.description ?? '') as string, viewOrder: match.viewOrder },
      })
    } else {
      // POST returns 200 with no body — resolve the id after by re-listing.
      const resp = await client.post(`${COMPLIANCE}/${requirement.id}/section`, sectionBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.standardName}/${spec.requirementId}/${spec.sectionId}: ${pcErrorMessage(resp)}`)
        continue
      }
      createdInRequirement.add(requirement.id)
      entries.push({
        itemId: spec.itemId,
        standardName: spec.standardName,
        requirementId: spec.requirementId,
        requirementFlatId: requirement.id,
        sectionId: spec.sectionId,
        existed: false,
        id: priorEntry?.id,
      })
    }
  }

  // Resolve ids for freshly-created sections (create doesn't return the id).
  for (const requirementFlatId of createdInRequirement) {
    const list = await listSections(client, requirementFlatId)
    if (!list) continue
    const bySectionId = new Map(list.filter((s) => s.sectionId).map((s) => [s.sectionId!.toLowerCase(), s]))
    for (const e of entries) {
      if (!e.existed && !e.id && e.requirementFlatId === requirementFlatId) {
        e.id = bySectionId.get(e.sectionId.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete sections THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => `${s.standardName.toLowerCase()} ${s.requirementId.toLowerCase()} ${s.sectionId.toLowerCase()}`))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    const key = `${p.standardName.toLowerCase()} ${p.requirementId.toLowerCase()} ${p.sectionId.toLowerCase()}`
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(key)) {
      const resp = await client.delete(`${COMPLIANCE}/requirement/section/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.standardName}/${p.requirementId}/${p.sectionId}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some sections failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} compliance section(s)`, rollbackData: { entries } }
}
