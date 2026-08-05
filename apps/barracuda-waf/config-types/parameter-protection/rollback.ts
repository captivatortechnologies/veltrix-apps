import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import type { ParameterProtectionRollbackData } from './deploy'

/** Roll back Parameter Protection by PATCHing back the exact object captured before this deploy. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, appName } = built

  const data = ctx.rollbackData as ParameterProtectionRollbackData | undefined
  if (!data?.prior) {
    return { success: true, message: 'Nothing to roll back — no prior Parameter Protection value was captured.' }
  }

  try {
    const res = await client.request('PATCH', `${client.appPath(appName)}/parameter_protection/`, { body: data.prior })
    if (!res.ok) throw new Error(`Failed to restore Parameter Protection: ${barracudaErrorMessage(res)}`)
    return { success: true, message: 'Rolled back Parameter Protection to its prior value.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
