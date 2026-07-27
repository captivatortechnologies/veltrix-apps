import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/qradar'
import type { RollbackData } from './deploy'

const PATH = '/config/network_hierarchy/staged_networks'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const data = ctx.rollbackData as RollbackData | undefined
  const priorList = Array.isArray(data?.priorList) ? data.priorList : []

  // Singleton restore: PUT the full snapshot captured before the deploy, then re-apply.
  const resp = await client.request('PUT', PATH, { body: priorList })
  if (!resp.ok) return { success: false, message: `Rollback failed: ${qradarErrorMessage(resp)}` }

  const dep = await client.deployStagedConfig('INCREMENTAL')
  if (!dep.ok) return { success: false, message: `Rollback staged but deploy failed: ${dep.message}` }

  return { success: true, message: `Restored ${priorList.length} network object(s)` }
}
