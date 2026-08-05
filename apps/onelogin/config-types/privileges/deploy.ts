import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, parseJson, oneLoginErrorMessage, type OneLoginClient } from '../../lib/oneLogin'
import { extractPrivilegeSpecs, parsePrivilegeDocument, type LivePrivilege } from './validate'

/** The full writable surface of a privilege document - everything create/update accepts. */
export interface PrivilegeWriteInput {
  name: string
  description: string
  privilege: unknown
}

export interface PrivilegeRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: PrivilegeWriteInput
  priorRoleIds?: number[]
  priorUserIds?: number[]
}

/**
 * Deploy OneLogin privileges via the Privileges API (requires a Delegated
 * Administration subscription).
 *
 * ONE item = ONE privilege, matched on NAME (OneLogin has no upsert):
 *   - list GET  /api/1/privileges         (client.getAll - handles both the
 *     bare-array and cursor-envelope response shapes; see lib/oneLogin.ts)
 *   - PUT       /api/1/privileges/{id}    - full document replace
 *   - POST      /api/1/privileges         - create a missing one (capture the new id)
 *
 * Then reconciles role/user ASSIGNMENT BY DIFF (OneLogin's Assign endpoints
 * ADD to the set; Remove endpoints remove ONE id at a time - there is no
 * single "set" call, unlike Roles' own Set Role Apps): this app computes
 * declared-minus-live (to add) and live-minus-declared (to remove), and
 * issues exactly those calls, so the net effect still converges to the
 * canvas's full declared set.
 *
 * Never deletes a privilege absent from this canvas - rollback only reverts
 * what THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractPrivilegeSpecs(ctx.canvas).filter((s) => s.name && s.statementJson)
  const rollbackState: PrivilegeRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const privileges = await listPrivileges(client)

    for (const spec of specs) {
      const document = parsePrivilegeDocument(spec.statementJson)
      if (!document) {
        throw new Error(`Privilege "${spec.name}": statement is not a valid policy document`)
      }
      const input: PrivilegeWriteInput = { name: spec.name, description: spec.description ?? '', privilege: document }
      const existing = privileges.find((p) => p.name === spec.name) ?? null

      let privilegeId: string
      if (existing?.id) {
        privilegeId = existing.id
        const [priorRoleIds, priorUserIds] = await Promise.all([
          getPrivilegeRoleIds(client, privilegeId),
          getPrivilegeUserIds(client, privilegeId),
        ])
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: privilegeId,
          prior: { name: existing.name ?? spec.name, description: existing.description ?? '', privilege: existing.privilege ?? {} },
          priorRoleIds,
          priorUserIds,
        })

        const res = await client.request('PUT', `/api/1/privileges/${privilegeId}`, { body: buildPrivilegeBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to update privilege "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
        await reconcileMembership(client, privilegeId, 'roles', priorRoleIds, spec.roleIds, spec.name)
        await reconcileMembership(client, privilegeId, 'users', priorUserIds, spec.userIds, spec.name)
      } else {
        const res = await client.request('POST', '/api/1/privileges', { body: buildPrivilegeBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to create privilege "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
        const created = parseJson<{ id?: string }>(res.body)
        if (!created?.id) {
          throw new Error(`Privilege "${spec.name}" was created but the API returned no id`)
        }
        privilegeId = created.id
        createdIds.push(privilegeId)
        rollbackState.push({ name: spec.name, existed: false, id: privilegeId })

        await reconcileMembership(client, privilegeId, 'roles', [], spec.roleIds, spec.name)
        await reconcileMembership(client, privilegeId, 'users', [], spec.userIds, spec.name)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} privilege(s) to OneLogin account ${domain}: ${deployed.join(', ')}`,
      artifacts: { domain, deployedPrivileges: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Privilege deployment failed after ${deployed.length} of ${specs.length} privilege(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedPrivileges: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every privilege in the account. Handles both response shapes OneLogin uses (see lib/oneLogin.ts). */
export async function listPrivileges(client: OneLoginClient): Promise<LivePrivilege[]> {
  const res = await client.getAll<LivePrivilege>('/api/1/privileges', { arrayKey: 'privileges' })
  if (!res.ok) {
    throw new Error(
      `Failed to list privileges: ${oneLoginErrorMessage({ status: res.status, ok: res.ok, body: res.body, linkHeader: null })}`,
    )
  }
  return res.items
}

export async function getPrivilegeRoleIds(client: OneLoginClient, privilegeId: string): Promise<number[]> {
  const res = await client.getAll<number>(`/api/1/privileges/${privilegeId}/roles`, { arrayKey: 'roles' })
  return res.ok ? res.items.map(Number).filter((n) => Number.isInteger(n)) : []
}

export async function getPrivilegeUserIds(client: OneLoginClient, privilegeId: string): Promise<number[]> {
  const res = await client.getAll<number>(`/api/1/privileges/${privilegeId}/users`, { arrayKey: 'users' })
  return res.ok ? res.items.map(Number).filter((n) => Number.isInteger(n)) : []
}

/**
 * Converge a privilege's role/user assignment to `targetIds` from
 * `currentIds` by issuing only the add/remove calls needed - OneLogin has no
 * single "set" endpoint for privilege assignment (unlike Roles' Set Role
 * Apps), so this computes the diff and calls Assign (batch add) / Remove
 * (one id at a time) accordingly.
 */
export async function reconcileMembership(
  client: OneLoginClient,
  privilegeId: string,
  kind: 'roles' | 'users',
  currentIds: number[],
  targetIds: number[],
  privilegeName: string,
): Promise<void> {
  const currentSet = new Set(currentIds)
  const targetSet = new Set(targetIds)
  const toAdd = targetIds.filter((id) => !currentSet.has(id))
  const toRemove = currentIds.filter((id) => !targetSet.has(id))

  if (toAdd.length > 0) {
    const res = await client.request('POST', `/api/1/privileges/${privilegeId}/${kind}`, { body: { [kind]: toAdd } })
    if (!res.ok) {
      throw new Error(`Failed to assign ${kind} to privilege "${privilegeName}": ${oneLoginErrorMessage(res)}`)
    }
  }
  for (const id of toRemove) {
    const res = await client.request('DELETE', `/api/1/privileges/${privilegeId}/${kind}/${id}`)
    if (res.status !== 404 && !res.ok) {
      throw new Error(`Failed to remove ${kind.slice(0, -1)} ${id} from privilege "${privilegeName}": ${oneLoginErrorMessage(res)}`)
    }
  }
}

export function buildPrivilegeBody(input: PrivilegeWriteInput): Record<string, unknown> {
  return { name: input.name, description: input.description, privilege: input.privilege }
}
