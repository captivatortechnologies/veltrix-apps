import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { buildRequestBody, type RollbackEntry } from './deploy'

const REQUESTS = '/roleManagement/directory/roleEligibilityScheduleRequests'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let revoked = 0
  let restored = 0

  // PIM has no direct delete/patch — every reversal is another schedule request.
  for (const e of entries) {
    const specLike = {
      principalId: e.principalId,
      roleDefinitionId: e.roleDefinitionId,
      directoryScopeId: e.directoryScopeId,
      justification: 'Reverted by Veltrix config as code',
      ticketNumber: '',
      ticketSystem: '',
    }

    if (e.action === 'adminAssign' && !e.existed) {
      // This deploy created the eligibility — remove it.
      const resp = await client.post(REQUESTS, buildRequestBody('adminRemove', specLike))
      if (!resp.ok) failures.push(`revoke ${e.name}: ${graphErrorMessage(resp)}`)
      else revoked++
    } else if (e.action === 'adminUpdate' && e.priorExpiration) {
      // This deploy changed the eligibility window — restore the prior schedule.
      const resp = await client.post(REQUESTS, buildRequestBody('adminUpdate', specLike, e.priorExpiration))
      if (!resp.ok) failures.push(`restore ${e.name}: ${graphErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back PIM eligibilities: ${revoked} revoked, ${restored} restored` }
}
