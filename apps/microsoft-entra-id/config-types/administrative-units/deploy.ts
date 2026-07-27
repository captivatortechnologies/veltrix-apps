import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractAdministrativeUnitSpecs,
  graphVisibility,
  type AdministrativeUnitSpec,
  type LiveAdministrativeUnit,
} from './validate'

const BASE = '/directory/administrativeUnits'
const SELECT = '?$select=id,displayName,description,visibility,membershipType'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the unit existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** Body for POST /directory/administrativeUnits — visibility null means public. */
export function buildCreateBody(spec: AdministrativeUnitSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
    visibility: graphVisibility(spec),
  }
}

/** Body for PATCH /directory/administrativeUnits/{id} — the mutable managed fields. */
export function buildPatchBody(spec: AdministrativeUnitSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
    visibility: graphVisibility(spec),
  }
}

function snapshotLive(live: LiveAdministrativeUnit): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? null,
    visibility: live.visibility ?? null,
  }
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

  const specs = extractAdministrativeUnitSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAdministrativeUnit>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list administrative units: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAdministrativeUnit>()
  const liveById = new Map<string, LiveAdministrativeUnit>()
  for (const u of listed.items) {
    if (u.displayName) liveByName.set(u.displayName.toLowerCase(), u)
    if (u.id) liveById.set(u.id, u)
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
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAdministrativeUnit>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete units THIS app created previously but no longer declares.
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
      message: `Some administrative units failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} administrative unit(s)`,
    rollbackData: { entries },
  }
}
