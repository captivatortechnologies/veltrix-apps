import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import type { AccountSettingsRollbackData } from './deploy'

const PATH = '/admin/v1/settings'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const data = ctx.rollbackData as AccountSettingsRollbackData | undefined
  const priorParams = data?.priorParams ?? {}

  if (Object.keys(priorParams).length === 0) {
    return { success: true, message: 'No prior account settings to restore' }
  }

  const resp = await client.post(PATH, priorParams)
  if (!resp.ok) return { success: false, message: `Failed to restore account settings: ${duoErrorMessage(resp)}` }

  return { success: true, message: `Restored account settings: ${Object.keys(priorParams).join(', ')}` }
}
