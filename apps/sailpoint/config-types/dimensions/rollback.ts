import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { RollbackEntry } from './deploy'

const childPath = (roleId: string): string => `/beta/roles/${roleId}/dimensions`

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
    if (!e.dimensionId) continue
    if (e.existed && e.prior) {
      const ops = [
        { op: 'replace', path: '/name', value: e.prior.name },
        { op: 'replace', path: '/description', value: e.prior.description },
        { op: 'replace', path: '/owner', value: { type: e.prior.ownerType, id: e.prior.ownerId } },
        { op: 'replace', path: '/accessProfiles', value: e.prior.accessProfileIds.map((id) => ({ type: 'ACCESS_PROFILE', id })) },
        { op: 'replace', path: '/entitlements', value: e.prior.entitlementIds.map((id) => ({ type: 'ENTITLEMENT', id })) },
      ]
      const resp = await client.patch(`${childPath(e.roleId)}/${e.dimensionId}`, ops)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${iscErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${childPath(e.roleId)}/${e.dimensionId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${iscErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back dimensions: ${deleted} deleted, ${restored} restored` }
}
