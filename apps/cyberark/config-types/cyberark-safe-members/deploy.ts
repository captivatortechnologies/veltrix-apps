import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCyberArkClient,
  cyberArkErrorMessage,
  encodeSafeUrlId,
  type CyberArkClient,
} from '../../lib/cyberark'
import {
  buildPermissionObject,
  enabledPermissions,
  extractSafeMemberSpecs,
  memberKey,
  type LiveSafeMember,
  type SafeMemberSpec,
} from './validate'

/**
 * Rollback state for one safe member. `prior` carries the member's previous
 * permissions + expiration (non-secret) so an updated member can be restored.
 */
export interface SafeMemberRollbackEntry {
  key: string
  label: string
  safeUrlId: string
  memberName: string
  existed: boolean
  prior?: { permissions: string[]; membershipExpiration: number | null }
}

/**
 * Deploy CyberArk safe members. Each member is a child of a safe: resolve the
 * safe by name to its safeUrlId, list the safe's members, match by member name,
 * then POST a new member or PUT an existing one. Identity is (safe, member).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractSafeMemberSpecs(ctx.canvas).filter((s) => s.safeName && s.memberName && s.permissions.length > 0)
  const rollbackState: SafeMemberRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const safeUrlIds = new Map<string, string>()

    for (const spec of specs) {
      const label = `${spec.memberName} @ ${spec.safeName}`
      const safeUrlId = await resolveSafeUrlId(client, spec.safeName, safeUrlIds)

      const existing = await listMembers(client, safeUrlId)
      const live = existing.find((m) => (m.memberName ?? '').toLowerCase() === spec.memberName.toLowerCase())
      const key = memberKey(spec)

      if (live) {
        rollbackState.push({
          key,
          label,
          safeUrlId,
          memberName: live.memberName ?? spec.memberName,
          existed: true,
          prior: { permissions: enabledPermissions(live.permissions), membershipExpiration: live.membershipExpirationDate ?? null },
        })
        const res = await client.request('PUT', `/Safes/${encodeSafeUrlId(safeUrlId)}/Members/${encodeURIComponent(spec.memberName)}`, {
          body: buildUpdateBody(spec),
        })
        if (!res.ok) throw new Error(`Failed to update member "${label}": ${cyberArkErrorMessage(res)}`)
      } else {
        rollbackState.push({ key, label, safeUrlId, memberName: spec.memberName, existed: false })
        const res = await client.request('POST', `/Safes/${encodeSafeUrlId(safeUrlId)}/Members`, {
          body: buildAddBody(spec),
        })
        if (!res.ok) throw new Error(`Failed to add member "${label}": ${cyberArkErrorMessage(res)}`)
      }
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} safe member(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      artifacts: { pvwaUrl, deployedMembers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Safe member deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedMembers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

interface LiveSafeRef {
  safeUrlId?: string
  safeName?: string
}

/** Resolve a safe name to its safeUrlId (cached); throws when the safe is missing. */
export async function resolveSafeUrlId(client: CyberArkClient, name: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(name.toLowerCase())
  if (cached !== undefined) return cached
  const res = await client.getAll<LiveSafeRef>('/Safes')
  if (!res.ok) {
    throw new Error(`Failed to list safes while resolving "${name}": ${cyberArkErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  for (const safe of res.items) {
    if (safe.safeName) cache.set(safe.safeName.toLowerCase(), safe.safeUrlId ?? safe.safeName)
  }
  const id = cache.get(name.toLowerCase())
  if (id === undefined) throw new Error(`Safe "${name}" not found — create the safe before managing its members`)
  return id
}

/** List a safe's members; throws on a non-OK response. */
export async function listMembers(client: CyberArkClient, safeUrlId: string): Promise<LiveSafeMember[]> {
  const res = await client.getAll<LiveSafeMember>(`/Safes/${encodeSafeUrlId(safeUrlId)}/Members`)
  if (!res.ok) {
    throw new Error(`Failed to list members for safe ${safeUrlId}: ${cyberArkErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Body for adding a new member — memberName/type/searchIn are fixed at creation. */
function buildAddBody(spec: SafeMemberSpec): Record<string, unknown> {
  return {
    memberName: spec.memberName,
    searchIn: spec.searchIn,
    memberType: spec.memberType,
    membershipExpirationDate: spec.membershipExpiration,
    permissions: buildPermissionObject(spec.permissions),
  }
}

/** Body for updating a member — only expiration + permissions may change. */
function buildUpdateBody(spec: SafeMemberSpec): Record<string, unknown> {
  return {
    membershipExpirationDate: spec.membershipExpiration,
    permissions: buildPermissionObject(spec.permissions),
  }
}
