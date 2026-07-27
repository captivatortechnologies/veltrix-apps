import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MimecastClient,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import {
  extractDirectoryGroupSpecs,
  groupKey,
  liveMemberIdentity,
  memberIdentity,
  type DirectoryGroupSpec,
  type LiveGroup,
  type LiveMember,
} from './validate'

const FIND = '/api/directory/find-groups'
const CREATE_GROUP = '/api/directory/create-group'
const DELETE_GROUP = '/api/directory/delete-group'
const GET_MEMBERS = '/api/directory/get-group-members'
const ADD_MEMBER = '/api/directory/add-group-member'
const REMOVE_MEMBER = '/api/directory/remove-group-member'

export interface RollbackEntry {
  itemId?: string
  /** the group description (its name). */
  name: string
  /** the parent group id ('' for root). */
  parentId: string
  /** whether a group with this identity existed BEFORE this app first managed it. */
  existed: boolean
  /** the group's secure id. */
  id?: string
  /** member identities THIS app added (and therefore owns). */
  addedMembers: string[]
}

/** Flatten a find-groups response into every group (recursing nested folders). */
export function extractGroups(data: unknown[]): LiveGroup[] {
  const out: LiveGroup[] = []
  const visit = (arr: LiveGroup[] | undefined): void => {
    for (const g of arr ?? []) {
      if (!g) continue
      if (g.id) out.push(g)
      if (Array.isArray(g.folders)) visit(g.folders)
    }
  }
  for (const row of data as Array<LiveGroup & { folders?: LiveGroup[] }>) {
    if (row && Array.isArray(row.folders)) visit(row.folders)
    else if (row?.id) out.push(row)
  }
  return out
}

/** Extract members from a get-group-members response (tolerates either shape). */
export function extractMembers(data: unknown[]): LiveMember[] {
  const out: LiveMember[] = []
  for (const row of data as Array<{ groupMembers?: LiveMember[] } & LiveMember>) {
    if (row && Array.isArray(row.groupMembers)) out.push(...row.groupMembers)
    else if (row && (row.emailAddress || row.domain)) out.push(row)
  }
  return out
}

function matchGroup(spec: DirectoryGroupSpec, groups: LiveGroup[]): LiveGroup | null {
  const desc = spec.description.toLowerCase()
  if (spec.parentId) {
    return groups.find((g) => (g.description ?? '').toLowerCase() === desc && g.parentId === spec.parentId) ?? null
  }
  return groups.find((g) => (g.description ?? '').toLowerCase() === desc) ?? null
}

/** Look up the live group matching a spec by name (parent-aware). */
async function findGroup(client: MimecastClient, spec: DirectoryGroupSpec): Promise<LiveGroup | null> {
  const resp = await client.request(FIND, { query: spec.description })
  if (!resp.ok) return null
  return matchGroup(spec, extractGroups(resp.data))
}

/** Build an add/remove-group-member body from a member identity. */
function memberBody(groupId: string, identity: string): Record<string, unknown> {
  const idx = identity.indexOf(':')
  const kind = identity.slice(0, idx)
  const value = identity.slice(idx + 1)
  return kind === 'email' ? { id: groupId, emailAddress: value } : { id: groupId, domain: value }
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

/** Reconcile a group's membership to `desired`, owning only what this app added. */
async function reconcileMembers(
  client: MimecastClient,
  groupId: string,
  desired: Set<string>,
  priorAdded: string[],
  failures: string[],
  label: string,
): Promise<string[]> {
  const membersResp = await client.request(GET_MEMBERS, { id: groupId })
  const live = new Set(membersResp.ok ? extractMembers(membersResp.data).map(liveMemberIdentity) : [])
  const owned = new Set(priorAdded)

  for (const id of desired) {
    if (live.has(id)) {
      owned.add(id)
      continue
    }
    const resp = await client.request(ADD_MEMBER, memberBody(groupId, id))
    if (!resp.ok) failures.push(`${label} add ${id}: ${mimecastErrorMessage(resp)}`)
    else owned.add(id)
  }

  for (const id of priorAdded) {
    if (desired.has(id)) continue
    if (live.has(id)) {
      const resp = await client.request(REMOVE_MEMBER, memberBody(groupId, id))
      if (!resp.ok) failures.push(`${label} remove ${id}: ${mimecastErrorMessage(resp)}`)
    }
    owned.delete(id)
  }

  return [...owned].filter((id) => desired.has(id))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildMimecastClient(cred, settings)

  const specs = extractDirectoryGroupSpecs(ctx.canvas).filter((s) => s.description)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(prior.map((e) => [groupKey({ description: e.name, parentId: e.parentId }), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const skipped: string[] = []

  for (const spec of specs) {
    const key = groupKey(spec)
    const found = await findGroup(client, spec)

    if (found?.source === 'ldap') {
      // LDAP-synced groups are managed by the directory connector, not as code.
      skipped.push(spec.description)
      continue
    }

    const priorEntry = priorByKey.get(key)
    const existed = priorEntry ? priorEntry.existed : Boolean(found)

    let groupId = found?.id
    if (!groupId) {
      const payload: Record<string, unknown> = { description: spec.description }
      if (spec.parentId) payload.parentId = spec.parentId
      const resp = await client.request(CREATE_GROUP, payload)
      if (!resp.ok) {
        failures.push(`${spec.description}: ${mimecastErrorMessage(resp)}`)
        continue
      }
      groupId = (resp.data[0] as { id?: string } | undefined)?.id
    }

    if (!groupId) {
      failures.push(`${spec.description}: group id missing after create`)
      continue
    }

    const desired = new Set(spec.members.map(memberIdentity))
    const addedMembers = await reconcileMembers(client, groupId, desired, priorEntry?.addedMembers ?? [], failures, spec.description)

    entries.push({ itemId: spec.itemId, name: spec.description, parentId: spec.parentId, existed, id: groupId, addedMembers })
  }

  // Reconcile: prune groups/members THIS app owns but no longer declares.
  const declaredKeys = new Set(specs.map((s) => groupKey(s)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (declaredKeys.has(groupKey({ description: p.name, parentId: p.parentId }))) continue
    if (!p.id || keptIds.has(p.id)) continue
    if (!p.existed) {
      // App-created group — empty its members, then delete it.
      const membersResp = await client.request(GET_MEMBERS, { id: p.id })
      if (membersResp.ok) {
        for (const m of extractMembers(membersResp.data)) {
          await client.request(REMOVE_MEMBER, memberBody(p.id, liveMemberIdentity(m)))
        }
      }
      const del = await client.request(DELETE_GROUP, { id: p.id })
      if (!del.ok) failures.push(`delete ${p.name}: ${mimecastErrorMessage(del)}`)
    } else {
      // Adopted group — leave it, but remove the members this app added.
      for (const id of p.addedMembers ?? []) {
        await client.request(REMOVE_MEMBER, memberBody(p.id, id))
      }
    }
  }

  const parts = [`Deployed ${entries.length} directory group(s)`]
  if (skipped.length) parts.push(`skipped ${skipped.length} LDAP-synced group(s): ${skipped.join(', ')}`)
  if (failures.length) {
    return { success: false, message: `Some directory groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: parts.join('; '), rollbackData: { entries } }
}
