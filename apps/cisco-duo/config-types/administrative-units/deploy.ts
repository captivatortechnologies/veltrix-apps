import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import { extractAdminUnitSpecs, type AdminUnitSpec, type LiveAdminUnit } from './validate'

const BASE = '/admin/v1/administrative_units'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the unit existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Duo admin_unit_id assigned to the administrative unit. */
  adminUnitId?: string
  /** Prior scalar fields captured before an update so rollback can restore them. */
  prior?: { name: string; description: string; restrictByGroups: boolean; restrictByIntegrations: boolean }
}

/** Form params for create/modify — only the scalar fields this app reconciles.
 *  Membership (admins/groups/integrations) is intentionally left to the Duo Admin
 *  Panel: those are addressed by opaque ids and the modify endpoint only ADDS to
 *  them, so they cannot be reconciled idempotently here. */
export function adminUnitParams(spec: AdminUnitSpec): Record<string, string> {
  return {
    name: spec.name,
    description: spec.description,
    restrict_by_groups: spec.restrictByGroups ? 'true' : 'false',
    restrict_by_integrations: spec.restrictByIntegrations ? 'true' : 'false',
  }
}

function firstUnit(response: unknown): LiveAdminUnit | null {
  if (Array.isArray(response)) return (response[0] as LiveAdminUnit) ?? null
  return (response as LiveAdminUnit) ?? null
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
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractAdminUnitSpecs(ctx.canvas).filter((s) => s.name && s.description)

  const listed = await client.getAll<LiveAdminUnit>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list administrative units: ${duoErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAdminUnit>()
  const liveById = new Map<string, LiveAdminUnit>()
  for (const u of listed.items) {
    if (u.name) liveByName.set(u.name.toLowerCase(), u)
    if (u.admin_unit_id) liveById.set(u.admin_unit_id, u)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the id stored last deploy (rename-safe), else match by name.
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.adminUnitId ? liveById.get(priorEntry.adminUnitId) : undefined) ??
      liveByName.get(spec.name.toLowerCase()) ??
      null

    if (liveMatch?.admin_unit_id) {
      const resp = await client.post(`${BASE}/${liveMatch.admin_unit_id}`, adminUnitParams(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        adminUnitId: liveMatch.admin_unit_id,
        prior: {
          name: liveMatch.name ?? '',
          description: (liveMatch.description ?? '') as string,
          restrictByGroups: liveMatch.restrict_by_groups === true,
          restrictByIntegrations: liveMatch.restrict_by_integrations === true,
        },
      })
    } else {
      const resp = await client.post(BASE, adminUnitParams(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      const created = firstUnit(resp.response)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, adminUnitId: created?.admin_unit_id })
    }
  }

  // Reconcile: delete units THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.adminUnitId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.adminUnitId && !keptIds.has(p.adminUnitId) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.adminUnitId}`)
      if (!resp.ok) failures.push(`delete ${p.name}: ${duoErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some administrative units failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} administrative unit(s)`, rollbackData: { entries } }
}
