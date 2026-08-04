import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import type { SessionPolicyRollbackEntry } from './deploy'

/**
 * Roll back platform session policies by restoring each platform's prior GET
 * response verbatim (a singleton PUT/GET resource — there is nothing to
 * create or delete, only to restore).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SessionPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const body: Record<string, unknown> = {}
      if (entry.prior.PSMServerId) body.PSMServerId = entry.prior.PSMServerId
      if (entry.prior.PSMServerName) body.PSMServerName = entry.prior.PSMServerName
      if (entry.prior.PSMConnectors?.length) body.PSMConnectors = entry.prior.PSMConnectors

      const res = await client.request('PUT', `/Platforms/Targets/${encodeURIComponent(entry.platformId)}/PrivilegedSessionManagement/`, { body })
      if (!res.ok) throw new Error(`Failed to restore session policy for platform "${entry.platformId}": ${cyberArkErrorMessage(res)}`)
      reverted.push(entry.platformId)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} platform session policy(ies): ${reverted.join(', ')}` }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
