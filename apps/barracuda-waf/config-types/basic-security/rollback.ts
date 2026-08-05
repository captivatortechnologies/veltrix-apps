import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import type { BasicSecurityRollbackData } from './deploy'

/** Roll back Basic Security by PATCHing back the exact protection_mode captured before this deploy. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, appName } = built

  const data = ctx.rollbackData as BasicSecurityRollbackData | undefined
  if (!data?.prior) {
    return { success: true, message: 'Nothing to roll back — no prior Basic Security value was captured.' }
  }

  try {
    const res = await client.request('PATCH', `${client.appPath(appName)}/basic_security/`, { body: data.prior })
    if (!res.ok) throw new Error(`Failed to restore Basic Security: ${barracudaErrorMessage(res)}`)
    return { success: true, message: `Rolled back Basic Security to protection mode "${data.prior.protection_mode}".` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
