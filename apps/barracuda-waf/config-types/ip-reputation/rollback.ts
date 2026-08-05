import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import type { IpReputationRollbackData } from './deploy'

/** Roll back IP Reputation by PATCHing back the exact object captured before this deploy. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, appName } = built

  const data = ctx.rollbackData as IpReputationRollbackData | undefined
  if (!data?.prior) {
    return { success: true, message: 'Nothing to roll back — no prior IP Reputation value was captured.' }
  }

  try {
    const res = await client.request('PATCH', `${client.appPath(appName)}/ip_reputation/`, { body: data.prior })
    if (!res.ok) throw new Error(`Failed to restore IP Reputation: ${barracudaErrorMessage(res)}`)
    return { success: true, message: 'Rolled back IP Reputation to its prior value.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
