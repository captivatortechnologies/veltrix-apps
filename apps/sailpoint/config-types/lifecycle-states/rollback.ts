import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { RollbackEntry } from './deploy'

const PROFILES = '/v3/identity-profiles'
const childPath = (profileId: string): string => `${PROFILES}/${profileId}/lifecycle-states`

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.stateId) continue
    if (e.existed && e.prior) {
      const ops = [
        { op: 'replace', path: '/name', value: e.prior.name },
        { op: 'replace', path: '/description', value: e.prior.description },
        { op: 'replace', path: '/enabled', value: e.prior.enabled },
        { op: 'replace', path: '/accessProfileIds', value: e.prior.accessProfileIds },
        { op: 'replace', path: '/accountActions', value: e.prior.accountActions },
      ]
      const resp = await client.patch(`${childPath(e.profileId)}/${e.stateId}`, ops)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.technicalName}: ${iscErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${childPath(e.profileId)}/${e.stateId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.technicalName}: ${iscErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back lifecycle states: ${deleted} deleted, ${restored} restored` }
}
