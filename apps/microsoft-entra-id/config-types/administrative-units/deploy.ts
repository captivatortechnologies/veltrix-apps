import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import {
  extractAdministrativeUnitSpecs,
  graphVisibility,
  type AdministrativeUnitSpec,
  type LiveAdministrativeUnit,
} from './validate'
import { buildDeviceNameToId, buildGroupNameToId, buildUserNameToId, resolveAcrossMapsMany } from '../lib/nameMaps'

const BASE = '/directory/administrativeUnits'
const SELECT = '?$select=id,displayName,description,visibility,membershipType'

/** One tracked administrative-unit member, with provenance. */
export interface MemberEntry {
  id: string
  /** false = this app added the member; true = it already belonged to the unit before this app touched it. */
  existed: boolean
}

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the unit existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
  /** Tracked members, with provenance — see MemberEntry. */
  members?: MemberEntry[]
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

/** GET the current member object ids of a unit (paginated). */
async function listMemberIds(client: GraphClient, unitId: string): Promise<{ ok: boolean; ids: Set<string> }> {
  const listed = await client.getAll<{ id?: string }>(`${BASE}/${unitId}/members?$select=id`)
  const ids = new Set<string>()
  if (listed.ok) {
    for (const m of listed.items) if (m.id) ids.add(m.id)
  }
  return { ok: listed.ok, ids }
}

/**
 * Reconcile one unit's membership to the declared set of ids.
 *
 * Adds a missing member with a single-item POST .../members/$ref — Graph
 * documents adding one member per request
 * (https://learn.microsoft.com/graph/api/administrativeunit-post-members).
 * The generic "/directoryObjects/{id}" @odata.id form works for any of the
 * three member kinds (user, group or device), so this needs no per-kind
 * branching.
 *
 * Removes ONLY members THIS app itself previously added (existed:false) that
 * are no longer declared — a member that already belonged to the unit before
 * this app touched it is left alone even if it later drops off the canvas
 * (same "never delete what we didn't create" rule this app applies to units,
 * role assignments and PIM eligibilities elsewhere in this batch).
 *
 * Removal uses DELETE .../members/{id}/$ref — the trailing "/$ref" is NOT
 * optional: Graph's own docs warn that without it (and if this app's
 * credential can manage the member object), the call deletes the member
 * OBJECT ITSELF from the directory instead of just removing it from the unit
 * (https://learn.microsoft.com/graph/api/administrativeunit-delete-members).
 */
export async function reconcileMembers(
  client: GraphClient,
  unitId: string,
  desiredIds: string[],
  priorMembers: MemberEntry[]
): Promise<{ members: MemberEntry[]; failures: string[] }> {
  const live = await listMemberIds(client, unitId)
  if (!live.ok) {
    return { members: priorMembers, failures: ['could not list current members — membership left unchanged'] }
  }

  const priorById = new Map(priorMembers.map((m) => [m.id, m]))
  const desiredSet = new Set(desiredIds)
  const members: MemberEntry[] = []
  const failures: string[] = []

  for (const id of desiredIds) {
    if (live.ids.has(id)) {
      // Already a member — inherit prior provenance if tracked, else it
      // predates this app's management and is treated as pre-existing.
      members.push({ id, existed: priorById.get(id)?.existed ?? true })
      continue
    }
    const resp = await client.post(`${BASE}/${unitId}/members/$ref`, {
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${id}`,
    })
    if (!resp.ok) {
      failures.push(`add member ${id}: ${graphErrorMessage(resp)}`)
      continue
    }
    members.push({ id, existed: false })
  }

  for (const p of priorMembers) {
    if (p.existed || desiredSet.has(p.id) || !live.ids.has(p.id)) continue
    const resp = await client.delete(`${BASE}/${unitId}/members/${p.id}/$ref`)
    if (!resp.ok && resp.status !== 404) {
      failures.push(`remove member ${p.id}: ${graphErrorMessage(resp)}`)
    }
  }

  return { members, failures }
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

  // Member references resolve against users/groups/devices — a picker-selected
  // value passes straight through; a hand-typed display name/UPN resolves via
  // these live maps (see ../lib/nameMaps).
  const [userMap, groupMap, deviceMap] = await Promise.all([
    buildUserNameToId(client),
    buildGroupNameToId(client),
    buildDeviceNameToId(client),
  ])

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    let unitId: string | undefined
    let entry: RollbackEntry

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      unitId = liveMatch.id
      entry = { itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) }
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAdministrativeUnit>(resp.body)
      unitId = created?.id
      entry = { itemId: spec.itemId, name: spec.name, existed: false, id: created?.id }
    }

    if (unitId) {
      const memberResolution = resolveAcrossMapsMany(spec.members, [userMap, groupMap, deviceMap])
      if (memberResolution.missing.length) {
        failures.push(
          `${spec.name}: unknown member(s) ${memberResolution.missing.join(', ')} — create/verify them first or fix the name`
        )
        // Leave membership exactly as last tracked — don't touch Graph until every member resolves.
        entry.members = priorEntry?.members ?? []
      } else {
        const { members, failures: memberFailures } = await reconcileMembers(
          client,
          unitId,
          memberResolution.ids,
          priorEntry?.members ?? []
        )
        entry.members = members
        for (const f of memberFailures) failures.push(`${spec.name}: ${f}`)
      }
    }

    entries.push(entry)
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
