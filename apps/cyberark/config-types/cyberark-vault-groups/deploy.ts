import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { cyberArkErrorMessage, parseCollectionArray, parseJson, buildCyberArkClient, type CyberArkClient } from '../../lib/cyberark'
import {
  groupMemberKey,
  vaultGroupKey,
  extractVaultGroupSpecs,
  parseGroupMembers,
  type GroupMemberSpec,
  type LiveGroupMember,
  type LiveVaultGroup,
} from './validate'

/**
 * Rollback state for one group. `priorMembers` is the FULL live membership
 * captured before reconciliation (for both a new and an existing group), so
 * rollback can restore it symmetrically.
 */
export interface VaultGroupRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: { groupName: string; description: string; location: string }
  priorMembers: LiveGroupMember[]
}

/**
 * Deploy CyberArk Vault groups via the PVWA Gen2 REST API.
 *
 * Identity is the group name: list /UserGroups, match by groupName, PUT an
 * existing group's fields (when changed) or POST a new one, then reconcile
 * membership (add/remove) against the declared member list. Unlike Account
 * Groups, this DOES support a full delete, so rollback is fully reversible.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractVaultGroupSpecs(ctx.canvas).filter((s) => s.groupName)
  const rollbackState: VaultGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const byKey = await mapGroups(client)

    for (const spec of specs) {
      const label = spec.groupName
      const key = vaultGroupKey(spec)
      let live = byKey.get(key)
      const existedBefore = !!live

      if (live?.id !== undefined) {
        const changed = (live.description ?? '') !== spec.description || (live.location ?? '\\') !== spec.location
        if (changed) {
          const res = await client.request('PUT', `/UserGroups/${encodeURIComponent(String(live.id))}`, {
            body: { groupName: spec.groupName, description: spec.description, location: spec.location },
          })
          if (!res.ok) throw new Error(`Failed to update group "${label}": ${cyberArkErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/UserGroups/', { body: { groupName: spec.groupName, description: spec.description, location: spec.location } })
        if (!res.ok) throw new Error(`Failed to create group "${label}": ${cyberArkErrorMessage(res)}`)
        live = parseJson<LiveVaultGroup>(res.body) ?? { groupName: spec.groupName }
        if (live.id !== undefined) createdIds.push(String(live.id))
      }

      const groupId = live?.id !== undefined ? String(live.id) : undefined
      let priorMembers: LiveGroupMember[] = []
      if (groupId) {
        priorMembers = await listGroupMembers(client, groupId)
        const desired = parseGroupMembers(spec.membersJson).value ?? []
        await reconcileGroupMembers(client, groupId, desired, priorMembers)
      }

      rollbackState.push({
        key,
        label,
        existed: existedBefore,
        id: groupId,
        prior: existedBefore ? { groupName: live?.groupName ?? label, description: live?.description ?? '', location: live?.location ?? '\\' } : undefined,
        priorMembers,
      })
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} Vault group(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      artifacts: { pvwaUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Vault group deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Vault groups; throws on a non-OK response. */
export async function listGroups(client: CyberArkClient): Promise<LiveVaultGroup[]> {
  const res = await client.request('GET', '/UserGroups/')
  if (!res.ok) throw new Error(`Failed to list Vault groups: ${cyberArkErrorMessage(res)}`)
  return parseCollectionArray<LiveVaultGroup>(res.body, ['value', 'UserGroups'])
}

/** Index Vault groups by their natural key (group name, lower-cased). */
export async function mapGroups(client: CyberArkClient): Promise<Map<string, LiveVaultGroup>> {
  const groups = await listGroups(client)
  return new Map(groups.filter((g) => typeof g.groupName === 'string' && g.groupName).map((g) => [vaultGroupKey({ groupName: g.groupName as string }), g]))
}

/** List a group's members (includeMembers=True); [] (not throw) on a non-OK response. */
export async function listGroupMembers(client: CyberArkClient, groupId: string): Promise<LiveGroupMember[]> {
  const res = await client.request('GET', `/UserGroups/${encodeURIComponent(groupId)}`, { query: { includeMembers: true } })
  if (!res.ok) return []
  const parsed = parseJson<LiveVaultGroup>(res.body)
  return Array.isArray(parsed?.members) ? (parsed?.members as LiveGroupMember[]) : []
}

function liveMemberSignature(m: LiveGroupMember): string {
  return groupMemberKey({ memberId: m.username ?? m.memberId ?? '', memberType: m.memberType ?? 'vault' })
}

/**
 * Reconcile a group's membership to `desired`, diffing against `live` by
 * their (memberId, memberType) signature. Adds every desired member missing
 * from live, removes every live member not in desired. Shared by deploy
 * (desired = spec) and rollback (desired = the captured prior list).
 */
export async function reconcileGroupMembers(client: CyberArkClient, groupId: string, desired: GroupMemberSpec[], live: LiveGroupMember[]): Promise<void> {
  const liveSignatures = new Set(live.map(liveMemberSignature))
  const desiredSignatures = new Set(desired.map((m) => groupMemberKey(m)))

  for (const member of desired) {
    if (liveSignatures.has(groupMemberKey(member))) continue
    const body: Record<string, unknown> = { memberId: member.memberId, memberType: member.memberType }
    if (member.domainName) body.domainName = member.domainName
    const res = await client.request('POST', `/UserGroups/${encodeURIComponent(groupId)}/Members`, { body })
    if (!res.ok) throw new Error(`Failed to add member "${member.memberId}" to group ${groupId}: ${cyberArkErrorMessage(res)}`)
  }
  for (const entry of live) {
    if (desiredSignatures.has(liveMemberSignature(entry))) continue
    const memberName = entry.username ?? entry.memberId
    if (!memberName) continue
    const res = await client.request('DELETE', `/UserGroups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberName)}`)
    if (res.status !== 404 && !res.ok) throw new Error(`Failed to remove member "${memberName}" from group ${groupId}: ${cyberArkErrorMessage(res)}`)
  }
}
