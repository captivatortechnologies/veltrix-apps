import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems, wazuhRequest } from '../../lib/wazuhApi'
import { diffIdSets } from './_shared'
import type { RollbackEntry } from './deploy'

interface WazuhUser {
  id: number
  username: string
  allow_run_as: boolean
  roles: number[]
}

async function applyRelationshipDiff(
  baseUrl: string,
  auth: Record<string, string>,
  path: string,
  idParam: string,
  toAdd: number[],
  toRemove: number[],
): Promise<void> {
  if (toAdd.length) {
    const url = `${baseUrl}${path}?${idParam}=${toAdd.join(',')}`
    const res = await wazuhRequest(url, { method: 'POST', headers: auth })
    if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
  if (toRemove.length) {
    const url = `${baseUrl}${path}?${idParam}=${toRemove.join(',')}`
    const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
    if (!res.ok) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
}

/**
 * Undo an API-user deploy from rollbackData.previous (written by deploy()): for
 * a user we created, DELETE it outright; for one we only reconciled, restore
 * their PRIOR `allow_run_as` flag and re-read their CURRENT roles to diff back
 * to the PRIOR set. Applied over the Wazuh REST API (55000).
 *
 * ⚠ A user whose PASSWORD was changed by the deploy cannot have that secret
 * restored — Wazuh never returns it, so it was never captured (see deploy.ts's
 * module doc). Rollback leaves their CURRENT password in place rather than risk
 * clearing it; reset it manually in Wazuh if the prior value must be recovered.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for API-user rollback' }
  }

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    for (const entry of previous) {
      if (entry.id == null) {
        skipped++
        continue
      }
      if (entry.created) {
        const url = `${baseUrl}/security/users?user_ids=${entry.id}`
        const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
        if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        deleted++
        continue
      }

      const runAsUrl = `${baseUrl}/security/users/${entry.id}/run_as?allow_run_as=${entry.priorAllowRunAs}`
      const runAsRes = await wazuhRequest(runAsUrl, { method: 'PUT', headers: auth })
      if (!runAsRes.ok) throw new Error(`PUT ${runAsUrl} → HTTP ${runAsRes.status}: ${runAsRes.body.slice(0, 300)}`)

      const [current] = await listAffectedItems<WazuhUser>(baseUrl, auth, `/security/users?user_ids=${entry.id}`)
      if (current) {
        const roleDiff = diffIdSets(current.roles, entry.priorRoleIds)
        await applyRelationshipDiff(baseUrl, auth, `/security/users/${entry.id}/roles`, 'role_ids', roleDiff.toAdd, roleDiff.toRemove)
      }

      restored++
    }
    return {
      success: true,
      message: `Rolled back API users: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}. Passwords (if changed) were NOT restored — see this handler's module doc.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
