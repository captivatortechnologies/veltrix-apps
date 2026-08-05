import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { type RollbackEntry } from './deploy'

const enc = encodeURIComponent
const UPDATE_MASK = 'enabled,archived,detectionExclusionApplication'

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
    // A findings refinement deployment is never created/deleted — restore the prior state we captured.
    if (!e.refinementId || !e.prior) continue
    const resp = await client.request('PATCH', `${parent}/findingsRefinements/${enc(e.refinementId)}/deployment?updateMask=${UPDATE_MASK}`, {
      enabled: e.prior.enabled,
      archived: e.prior.archived,
      detectionExclusionApplication: { rules: e.prior.application.rules, curatedRuleSets: e.prior.application.curatedRuleSets, curatedRules: e.prior.application.curatedRules },
    })
    if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.refinementName}: ${secopsErrorMessage(resp)}`)
    else restored++
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back findings refinement deployments: ${restored} restored` }
}
