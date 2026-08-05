import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import type { RollbackEntry } from './deploy'

const BASE = '/profiles/customcategories'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      const resp = await client.patch(`${BASE}/${e.id}`, {
        name: e.prior.name,
        description: e.prior.description,
        included_predefined_categories: e.prior.included_predefined_categories,
        included_url_lists: e.prior.included_url_lists,
        excluded_url_lists: e.prior.excluded_url_lists,
        included_destination_profiles: e.prior.included_destination_profiles,
        excluded_destination_profiles: e.prior.excluded_destination_profiles,
      })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${netskopeErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${netskopeErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back custom categories: ${deleted} deleted, ${restored} restored` }
}
