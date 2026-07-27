import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import type { RollbackEntry } from './deploy'

const BASE = '/policies/authenticationStrengthPolicies'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      // Restore metadata, then the combinations via the dedicated action.
      const patched = await client.patch(`${BASE}/${e.id}`, {
        displayName: e.prior.displayName,
        description: e.prior.description ?? null,
      })
      if (!patched.ok && patched.status !== 404) {
        failures.push(`restore ${e.name}: ${graphErrorMessage(patched)}`)
        continue
      }
      if (e.prior.allowedCombinations && e.prior.allowedCombinations.length > 0) {
        const combo = await client.post(`${BASE}/${e.id}/updateAllowedCombinations`, {
          allowedCombinations: e.prior.allowedCombinations,
        })
        if (!combo.ok && combo.status !== 404) {
          failures.push(`restore ${e.name}: ${graphErrorMessage(combo)}`)
          continue
        }
      }
      restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${graphErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back authentication strengths: ${deleted} deleted, ${restored} restored` }
}
