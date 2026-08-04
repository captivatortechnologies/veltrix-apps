import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { cyberArkErrorMessage, parseCollectionArray, parseJson, buildCyberArkClient, type CyberArkClient } from '../../lib/cyberark'
import { findAccount } from '../cyberark-accounts/deploy'
import { groupKey, extractAccountGroupSpecs, parseMembers, type LiveAccountGroup } from './validate'

/**
 * Rollback state for one account group. `priorMemberAccountIds` is the FULL
 * live membership captured before reconciliation, so rollback can restore it
 * symmetrically. `groupId` is required to reconcile members at all — a group
 * created moments ago but never found again (should not happen) is skipped.
 */
export interface AccountGroupRollbackEntry {
  key: string
  label: string
  existed: boolean
  groupId?: string
  safeName: string
  priorMemberAccountIds: string[]
}

/**
 * Deploy CyberArk account groups via the PVWA Gen2 REST API.
 *
 * Identity is (Safe, GroupName): list /AccountGroups?Safe=..., match on
 * GroupName, POST create when missing. ⚠ NO UPDATE ENDPOINT exists for a
 * group's own fields (GroupPlatformID) — an existing group's platform is left
 * untouched (see README "Coverage"); only membership is reconciled.
 *
 * Each declared member is (account name, safe) — resolved to CyberArk's
 * internal AccountID via the accounts config type's own account lookup, so
 * this type never needs to know CyberArk's opaque AccountID format.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractAccountGroupSpecs(ctx.canvas).filter((s) => s.groupName && s.safeName && s.groupPlatformId)
  const rollbackState: AccountGroupRollbackEntry[] = []
  const deployed: string[] = []
  const notes: string[] = []

  try {
    const bySafe = new Map<string, Map<string, LiveAccountGroup>>()

    for (const spec of specs) {
      const label = `${spec.groupName} @ ${spec.safeName}`
      const key = groupKey(spec)
      const safeLower = spec.safeName.toLowerCase()

      if (!bySafe.has(safeLower)) bySafe.set(safeLower, await mapGroupsBySafe(client, spec.safeName))
      const groups = bySafe.get(safeLower) as Map<string, LiveAccountGroup>
      let live = groups.get(spec.groupName.toLowerCase())
      const existedBefore = !!live

      if (!live) {
        const res = await client.request('POST', '/AccountGroups/', {
          body: { GroupName: spec.groupName, GroupPlatformID: spec.groupPlatformId, Safe: spec.safeName },
        })
        if (!res.ok) throw new Error(`Failed to create account group "${label}": ${cyberArkErrorMessage(res)}`)
        const created = parseJson<LiveAccountGroup>(res.body)
        live = created ?? { GroupName: spec.groupName, Safe: spec.safeName }
        groups.set(spec.groupName.toLowerCase(), live)
      } else if (live.GroupPlatformID && live.GroupPlatformID !== spec.groupPlatformId) {
        notes.push(`Account group "${label}" already exists with platform "${live.GroupPlatformID}" — GroupPlatformID cannot be changed (no update endpoint); "${spec.groupPlatformId}" was not applied`)
      }

      const groupId = live.GroupID !== undefined ? String(live.GroupID) : undefined
      let priorMemberAccountIds: string[] = []
      if (groupId) {
        priorMemberAccountIds = await listGroupMemberIds(client, groupId)
        const desiredIds: string[] = []
        const members = parseMembers(spec.membersJson).value ?? []
        for (const member of members) {
          const account = await findAccount(client, { name: member.accountName, safeName: member.safeName })
          if (!account?.id) {
            throw new Error(`Account "${member.accountName}" in safe "${member.safeName}" was not found for group "${label}" membership`)
          }
          desiredIds.push(account.id)
        }
        await reconcileMembers(client, groupId, desiredIds, priorMemberAccountIds)
      } else {
        notes.push(`Account group "${label}" was created but returned no GroupID — membership could not be reconciled this deploy`)
      }

      rollbackState.push({ key, label, existed: existedBefore, groupId, safeName: spec.safeName, priorMemberAccountIds })
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} account group(s) to ${pvwaUrl}: ${deployed.join(', ')}${notes.length ? ` (${notes.length} note(s))` : ''}`,
      artifacts: { pvwaUrl, deployedGroups: deployed, notes },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Account group deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedGroups: deployed, notes },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** List account groups for one safe; [] (not throw) on a non-OK response. */
export async function listGroupsBySafe(client: CyberArkClient, safeName: string): Promise<LiveAccountGroup[]> {
  const res = await client.request('GET', '/AccountGroups', { query: { Safe: safeName } })
  if (!res.ok) return []
  return parseCollectionArray<LiveAccountGroup>(res.body, ['value', 'AccountGroups', 'GetAccountGroupsResult'])
}

/** Index one safe's account groups by GroupName (lower-cased). */
export async function mapGroupsBySafe(client: CyberArkClient, safeName: string): Promise<Map<string, LiveAccountGroup>> {
  const groups = await listGroupsBySafe(client, safeName)
  return new Map(groups.filter((g) => typeof g.GroupName === 'string' && g.GroupName).map((g) => [(g.GroupName as string).toLowerCase(), g]))
}

/** List a group's member AccountIDs; [] (not throw) on a non-OK response. */
export async function listGroupMemberIds(client: CyberArkClient, groupId: string): Promise<string[]> {
  const res = await client.request('GET', `/AccountGroups/${encodeURIComponent(groupId)}/Members/`)
  if (!res.ok) return []
  const entries = parseCollectionArray<unknown>(res.body, ['value', 'GroupMembers', 'Members'])
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object') {
        const rec = entry as Record<string, unknown>
        const id = rec.AccountID ?? rec.accountId ?? rec.id
        return id !== undefined ? String(id) : null
      }
      return null
    })
    .filter((id): id is string => id !== null)
}

/**
 * Reconcile a group's membership to `desiredIds`, diffing against
 * `liveIds`. Adds every desired AccountID missing from live, removes every
 * live AccountID not in desired. Shared by deploy (desired = spec) and
 * rollback (desired = the captured prior list).
 */
export async function reconcileMembers(client: CyberArkClient, groupId: string, desiredIds: string[], liveIds: string[]): Promise<void> {
  const liveSet = new Set(liveIds)
  const desiredSet = new Set(desiredIds)

  for (const id of desiredIds) {
    if (liveSet.has(id)) continue
    const res = await client.request('POST', `/AccountGroups/${encodeURIComponent(groupId)}/Members/`, { body: { AccountID: id } })
    if (!res.ok) throw new Error(`Failed to add account ${id} to group ${groupId}: ${cyberArkErrorMessage(res)}`)
  }
  for (const id of liveIds) {
    if (desiredSet.has(id)) continue
    const res = await client.request('DELETE', `/AccountGroups/${encodeURIComponent(groupId)}/Members/${encodeURIComponent(id)}/`)
    if (res.status !== 404 && !res.ok) throw new Error(`Failed to remove account ${id} from group ${groupId}: ${cyberArkErrorMessage(res)}`)
  }
}
