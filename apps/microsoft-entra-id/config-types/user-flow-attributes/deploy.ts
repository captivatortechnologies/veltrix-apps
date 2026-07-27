import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractUserFlowAttributeSpecs, type UserFlowAttributeSpec, type LiveUserFlowAttribute } from './validate'

const BASE = '/identity/userFlowAttributes'
const SELECT = '?$select=id,displayName,dataType,userFlowAttributeType,description'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** Create body includes the immutable dataType; PATCH carries only description. */
export function buildCreateBody(spec: UserFlowAttributeSpec): Record<string, unknown> {
  return { displayName: spec.name, dataType: spec.dataType, description: spec.description || '' }
}

export function buildPatchBody(spec: UserFlowAttributeSpec): Record<string, unknown> {
  return { description: spec.description || '' }
}

function isCustom(a: LiveUserFlowAttribute): boolean {
  return a.userFlowAttributeType === 'custom'
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
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractUserFlowAttributeSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveUserFlowAttribute>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list user flow attributes: ${graphErrorMessage(listed.lastError!)}` }
  }
  // Only custom attributes are manageable — built-ins are read-only.
  const liveByName = new Map<string, LiveUserFlowAttribute>()
  const liveById = new Map<string, LiveUserFlowAttribute>()
  for (const a of listed.items) {
    if (!isCustom(a)) continue
    if (a.displayName) liveByName.set(a.displayName.toLowerCase(), a)
    if (a.id) liveById.set(a.id, a)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: liveMatch.id,
        prior: { description: liveMatch.description ?? '' },
      })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveUserFlowAttribute>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete custom attributes THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some user flow attributes failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} user flow attribute(s)`,
    rollbackData: { entries },
  }
}
