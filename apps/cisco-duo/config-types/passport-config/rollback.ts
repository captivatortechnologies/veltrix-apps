import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import type { PassportRollbackData } from './deploy'

const PATH = '/admin/v2/passport/config'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const prior = (ctx.rollbackData as PassportRollbackData | undefined)?.prior
  if (!prior) return { success: false, message: 'No previous Passport config captured for rollback' }

  const resp = await client.postV5(PATH, prior as unknown as Record<string, unknown>)
  if (!resp.ok) return { success: false, message: `Failed to restore Passport config: ${duoErrorMessage(resp)}` }

  return { success: true, message: `Restored Passport config to "${prior.enabled_status}"` }
}
