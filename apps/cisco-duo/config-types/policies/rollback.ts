import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import type { RollbackEntry } from './deploy'

const BASE = '/admin/v2/policies'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.policyKey) continue
    if (!e.existed && !e.isGlobal) {
      // We created this one — remove it.
      const resp = await client.deleteV5(`${BASE}/${e.policyKey}`)
      if (!resp.ok) failures.push(`delete ${e.name}: ${duoErrorMessage(resp)}`)
      else deleted++
    } else if (e.existed && e.prior) {
      // We updated this one — restore its prior name/sections, clearing any
      // sections we added that the prior did not have.
      const priorSections = e.prior.sections ?? {}
      const body: Record<string, unknown> = { sections: priorSections }
      if (!e.isGlobal) {
        body.policy_name = e.prior.policyName
        const added = (e.appliedSectionKeys ?? []).filter((k) => !(k in priorSections))
        if (added.length) body.sections_to_delete = added
      }
      const resp = await client.putV5(`${BASE}/${e.policyKey}`, body)
      if (!resp.ok) failures.push(`restore ${e.name}: ${duoErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back policies: ${deleted} deleted, ${restored} restored` }
}
