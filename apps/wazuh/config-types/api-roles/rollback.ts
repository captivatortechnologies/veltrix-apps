import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems, wazuhRequest } from '../../lib/wazuhApi'
import { diffIdSets } from './_shared'
import type { RollbackEntry } from './deploy'

interface WazuhRole {
  id: number
  name: string
  policies: number[]
  rules: number[]
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
 * Undo an API-role deploy from rollbackData.previous (written by deploy()):
 * for a role we created, DELETE it outright; for one we only reconciled,
 * re-read its CURRENT policy/rule ids and diff back to the PRIOR sets so the
 * relationship ends up exactly as it was before this deploy. Applied over the
 * Wazuh REST API (55000).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for API-role rollback' }
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
        const url = `${baseUrl}/security/roles?role_ids=${entry.id}`
        const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
        if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        deleted++
        continue
      }

      const [current] = await listAffectedItems<WazuhRole>(baseUrl, auth, `/security/roles?role_ids=${entry.id}`)
      if (!current) {
        skipped++
        continue
      }

      const policyDiff = diffIdSets(current.policies, entry.priorPolicyIds)
      await applyRelationshipDiff(baseUrl, auth, `/security/roles/${entry.id}/policies`, 'policy_ids', policyDiff.toAdd, policyDiff.toRemove)

      const ruleDiff = diffIdSets(current.rules, entry.priorRuleIds)
      await applyRelationshipDiff(baseUrl, auth, `/security/roles/${entry.id}/rules`, 'rule_ids', ruleDiff.toAdd, ruleDiff.toRemove)

      restored++
    }
    return { success: true, message: `Rolled back API roles: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
