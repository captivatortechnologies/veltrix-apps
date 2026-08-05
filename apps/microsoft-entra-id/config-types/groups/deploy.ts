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
  effectiveNickname,
  extractGroupSpecs,
  isManageableSecurityGroup,
  type GroupSpec,
  type LiveGroup,
} from './validate'
import { buildOwnerPrincipalNameMaps, resolveOwnerPrincipals } from '../lib/principals'
import { buildDeviceNameToId, buildGroupNameToId, buildServicePrincipalNameToId, buildUserNameToId, resolveAcrossMapsMany } from '../lib/nameMaps'
import { reconcileRefCollection, type RefMemberEntry } from '../lib/refReconcile'

const BASE = '/groups'
/** Trim the live group projection to just what we can list + reason about. */
const SELECT = '?$select=id,displayName,description,mailNickname,mailEnabled,securityEnabled,groupTypes'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the group existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior managed fields, captured before an update so rollback can restore them. */
  prior?: Record<string, unknown>
  /** Tracked owners, with provenance — see RefMemberEntry. */
  owners?: RefMemberEntry[]
  /** Tracked members, with provenance — see RefMemberEntry. */
  members?: RefMemberEntry[]
}

/** Build the four member-kind name maps once per deploy/drift run. */
async function buildMemberNameMaps(client: GraphClient) {
  const [user, group, device, servicePrincipal] = await Promise.all([
    buildUserNameToId(client),
    buildGroupNameToId(client),
    buildDeviceNameToId(client),
    buildServicePrincipalNameToId(client),
  ])
  return [user, group, device, servicePrincipal]
}

/** Body for POST /groups — securityEnabled assigned group (never mail-enabled). */
export function buildCreateBody(spec: GroupSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
    mailEnabled: false,
    mailNickname: effectiveNickname(spec),
    securityEnabled: true,
    groupTypes: [],
  }
}

/** Body for PATCH /groups/{id} — only the mutable managed fields. */
export function buildPatchBody(spec: GroupSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
    mailNickname: effectiveNickname(spec),
  }
}

function snapshotLive(live: LiveGroup): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? null,
    mailNickname: live.mailNickname ?? null,
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

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveGroup>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list groups: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveGroup>()
  const liveById = new Map<string, LiveGroup>()
  for (const g of listed.items) {
    if (g.displayName) liveByName.set(g.displayName.toLowerCase(), g)
    if (g.id) liveById.set(g.id, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  // Owner references resolve against users/service principals — a
  // picker-selected value passes straight through; a hand-typed display
  // name/UPN (pre-picker convention) falls back to these live maps.
  const ownerMaps = await buildOwnerPrincipalNameMaps(client)
  // Member references resolve against users/groups/devices/service principals.
  const memberMaps = await buildMemberNameMaps(client)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    let groupId: string | undefined
    let entry: RollbackEntry

    if (liveMatch?.id) {
      // Never modify a group that isn't a plain assigned security group — it may
      // be a built-in, mail, M365 or dynamic group that merely shares the name.
      if (!isManageableSecurityGroup(liveMatch)) {
        failures.push(`${spec.name}: a non-security or dynamic/M365 group with this name already exists and will not be modified`)
        continue
      }
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      groupId = liveMatch.id
      entry = { itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) }
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveGroup>(resp.body)
      groupId = created?.id
      entry = { itemId: spec.itemId, name: spec.name, existed: false, id: created?.id }
    }

    if (groupId) {
      const ownerResolution = resolveOwnerPrincipals(spec.owners, ownerMaps)
      if (ownerResolution.missing.length) {
        failures.push(
          `${spec.name}: unknown owner(s) ${ownerResolution.missing.join(', ')} — create/verify them first or fix the name`
        )
        // Leave ownership exactly as last tracked — don't touch Graph until every owner resolves.
        entry.owners = priorEntry?.owners ?? []
      } else {
        const { members: ownerMembers, failures: ownerFailures } = await reconcileRefCollection(
          client,
          `${BASE}/${groupId}`,
          'owners',
          ownerResolution.ids,
          priorEntry?.owners ?? []
        )
        entry.owners = ownerMembers
        for (const f of ownerFailures) failures.push(`${spec.name}: ${f}`)
      }

      const memberResolution = resolveAcrossMapsMany(spec.members, memberMaps)
      if (memberResolution.missing.length) {
        failures.push(
          `${spec.name}: unknown member(s) ${memberResolution.missing.join(', ')} — create/verify them first or fix the name`
        )
        // Leave membership exactly as last tracked — don't touch Graph until every member resolves.
        entry.members = priorEntry?.members ?? []
      } else {
        const { members, failures: memberFailures } = await reconcileRefCollection(
          client,
          `${BASE}/${groupId}`,
          'members',
          memberResolution.ids,
          priorEntry?.members ?? []
        )
        entry.members = members
        for (const f of memberFailures) failures.push(`${spec.name}: ${f}`)
      }
    }

    entries.push(entry)
  }

  // Reconcile: delete groups THIS app created previously but no longer declares.
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
      message: `Some groups failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} group(s)`,
    rollbackData: { entries },
  }
}
