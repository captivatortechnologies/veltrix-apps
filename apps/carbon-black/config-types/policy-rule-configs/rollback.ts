import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/carbonblack'
import { RULE_CONFIG_CATEGORY } from './validate'
import type { RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const policiesPath = client.policiesPath()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let reset = 0

  for (const e of entries) {
    if (!e.policyId) continue
    const rulePath = `${policiesPath}/${e.policyId}/rule_configs`
    const configs = e.prior?.configs ?? []
    if (configs.length) {
      // Restore each config's prior parameters/exclusions in place. Never delete
      // the policy — the rule-config category is platform-managed.
      const body = configs.map((c) => ({
        id: c.id,
        parameters: { WindowsAssignmentMode: c.WindowsAssignmentMode ?? 'BLOCK' },
        ...(c.exclusions ? { exclusions: c.exclusions } : {}),
      }))
      const resp = await client.put(`${rulePath}/${RULE_CONFIG_CATEGORY}`, body)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.policyName}: ${cbErrorMessage(resp)}`)
      else restored++
    } else {
      const del = await client.delete(`${rulePath}/${RULE_CONFIG_CATEGORY}`)
      if (!del.ok && del.status !== 404) failures.push(`reset ${e.policyName}: ${cbErrorMessage(del)}`)
      else reset++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back policy rule configs: ${restored} restored, ${reset} reset to default` }
}
