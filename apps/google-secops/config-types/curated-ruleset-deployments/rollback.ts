import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { deploymentPath, type RollbackEntry } from './deploy'

const UPDATE_MASK = 'enabled,alerting'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0

  for (const e of entries) {
    // A curated deployment is never created/deleted — restore the prior state.
    if (!e.prior) continue
    const resp = await client.request('PATCH', `${deploymentPath(parent, e)}?updateMask=${UPDATE_MASK}`, {
      enabled: e.prior.enabled,
      alerting: e.prior.alerting,
    })
    if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.category}/${e.ruleSet}/${e.precision}: ${secopsErrorMessage(resp)}`)
    else restored++
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back curated rule set deployments: ${restored} restored` }
}
