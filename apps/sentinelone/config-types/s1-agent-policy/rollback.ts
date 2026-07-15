import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'

const DEPRECATED_KEYS = ['agentNotification', 'agentUiOn']

/**
 * Roll back the agent policy by PUTting the whole prior policy (captured before
 * deploy) back to the scope — a read-modify-write is reverted by restoring the
 * pre-deploy object.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const data = ctx.rollbackData as { priorPolicy?: Record<string, unknown>; path?: string } | undefined
  if (!data || !data.priorPolicy) {
    return { success: false, message: 'No previous policy available for rollback' }
  }

  const path = data.path ?? client.policyPath().path
  if (!path) return { success: false, message: 'Could not resolve the policy path for rollback' }

  const prior: Record<string, unknown> = JSON.parse(JSON.stringify(data.priorPolicy))
  for (const key of DEPRECATED_KEYS) delete prior[key]

  try {
    const res = await client.request('PUT', path, { body: { data: prior } })
    if (!res.ok) throw new Error(s1ErrorMessage(res))
    return { success: true, message: 'Rolled back the agent policy to its prior state' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
