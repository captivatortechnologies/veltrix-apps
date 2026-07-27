import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import type { RollbackEntry } from './deploy'

const POLICIES = '/policies/roleManagementPolicies'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0

  // Rules are never created/deleted — restore the prior rule bodies for each role.
  for (const e of entries) {
    if (!e.existed || !e.policyId || !e.priorRules) continue
    for (const [ruleId, body] of Object.entries(e.priorRules)) {
      const resp = await client.patch(`${POLICIES}/${e.policyId}/rules/${ruleId}`, body)
      if (!resp.ok) failures.push(`restore ${e.name} (${ruleId}): ${graphErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back PIM activation rules (${restored} rule(s) restored)` }
}
