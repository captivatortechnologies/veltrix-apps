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
import { extractRequirementSpecs, type LiveRequirement, type RequirementSpec } from './validate'
import type { LiveStandard } from '../compliance-standards/validate'

const COMPLIANCE = '/compliance'

export interface RollbackEntry {
  itemId?: string
  standardName: string
  complianceId?: string
  requirementId: string
  /** Whether the requirement existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The requirement's own id (flat-addressed for update/delete). */
  id?: string
  prior?: { name: string; requirementId: string; description: string; viewOrder?: number }
}

export function requirementBody(spec: RequirementSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    requirementId: spec.requirementId,
    description: spec.description,
  }
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

  const specs = extractRequirementSpecs(ctx.canvas).filter((s) => s.standardName && s.requirementId)

  const standards = await listStandards(client)
  if (!standards) return { success: false, message: 'Failed to list compliance standards' }
  const standardByName = new Map<string, LiveStandard>()
  for (const s of standards) if (s.name) standardByName.set(s.name.toLowerCase(), s)

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  // Cache the live requirement list per standard, and remember which need a re-fetch.
  const liveByStandard = new Map<string, Map<string, LiveRequirement>>()
  const createdInStandard = new Set<string>()

  async function liveRequirements(complianceId: string): Promise<Map<string, LiveRequirement> | null> {
    const cached = liveByStandard.get(complianceId)
    if (cached) return cached
    const list = await listRequirements(client, complianceId)
    if (!list) return null
    const map = new Map<string, LiveRequirement>()
    for (const r of list) if (r.requirementId) map.set(r.requirementId.toLowerCase(), r)
    liveByStandard.set(complianceId, map)
    return map
  }

  for (const spec of specs) {
    const standard = standardByName.get(spec.standardName.toLowerCase())
    if (!standard?.id) {
      failures.push(`${spec.requirementId}: parent standard "${spec.standardName}" not found — declare it on the Compliance Standards canvas first`)
      continue
    }
    if (standard.systemDefault) {
      failures.push(`${spec.requirementId}: standard "${spec.standardName}" is a built-in standard and cannot take custom requirements`)
      continue
    }

    const live = await liveRequirements(standard.id)
    if (!live) {
      failures.push(`${spec.requirementId}: failed to list requirements for "${spec.standardName}"`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const match = live.get(spec.requirementId.toLowerCase())

    if (match?.id) {
      const resp = await client.put(`${COMPLIANCE}/requirement/${match.id}`, requirementBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.standardName}/${spec.requirementId}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        standardName: spec.standardName,
        complianceId: standard.id,
        requirementId: spec.requirementId,
        existed: true,
        id: match.id,
        prior: { name: match.name ?? '', requirementId: match.requirementId ?? '', description: (match.description ?? '') as string, viewOrder: match.viewOrder },
      })
    } else {
      // POST returns 200 with no body — resolve the id after by re-listing.
      const resp = await client.post(`${COMPLIANCE}/${standard.id}/requirement`, requirementBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.standardName}/${spec.requirementId}: ${pcErrorMessage(resp)}`)
        continue
      }
      createdInStandard.add(standard.id)
      entries.push({
        itemId: spec.itemId,
        standardName: spec.standardName,
        complianceId: standard.id,
        requirementId: spec.requirementId,
        existed: false,
        id: priorEntry?.id,
      })
    }
  }

  // Resolve ids for freshly-created requirements (create doesn't return the id).
  for (const complianceId of createdInStandard) {
    const list = await listRequirements(client, complianceId)
    if (!list) continue
    const byReqId = new Map(list.filter((r) => r.requirementId).map((r) => [r.requirementId!.toLowerCase(), r]))
    for (const e of entries) {
      if (!e.existed && !e.id && e.complianceId === complianceId) {
        e.id = byReqId.get(e.requirementId.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete requirements THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => `${s.standardName.toLowerCase()} ${s.requirementId.toLowerCase()}`))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    const key = `${p.standardName.toLowerCase()} ${p.requirementId.toLowerCase()}`
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(key)) {
      const resp = await client.delete(`${COMPLIANCE}/requirement/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.standardName}/${p.requirementId}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some requirements failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} compliance requirement(s)`, rollbackData: { entries } }
}
