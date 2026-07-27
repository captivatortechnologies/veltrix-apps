import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { REFINEMENT_TYPE } from './validate'
import { type RollbackEntry } from './deploy'

const enc = encodeURIComponent

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
  let disabled = 0

  for (const e of entries) {
    if (!e.refinementId) continue
    if (!e.existed) {
      // We created this refinement — it cannot be deleted, so disable + archive it.
      const resp = await client.request('PATCH', `${parent}/findingsRefinements/${enc(e.refinementId)}/deployment?updateMask=enabled,archived`, { enabled: false, archived: true })
      if (!resp.ok && resp.status !== 404) failures.push(`disable ${e.displayName}: ${secopsErrorMessage(resp)}`)
      else disabled++
    } else if (e.prior) {
      // We updated this refinement — restore its prior definition.
      const resp = await client.request('PATCH', `${parent}/findingsRefinements/${enc(e.refinementId)}?updateMask=displayName,query,outcomeFilters`, {
        displayName: e.prior.displayName,
        type: REFINEMENT_TYPE,
        query: e.prior.query,
        outcomeFilters: e.prior.outcomeFilters ?? [],
      })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.displayName}: ${secopsErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back findings refinements: ${disabled} disabled, ${restored} restored` }
}
