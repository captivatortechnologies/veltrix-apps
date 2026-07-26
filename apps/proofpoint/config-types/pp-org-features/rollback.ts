import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { getFeatures } from './validate'
import type { FeatureRollbackData } from './deploy'

/**
 * Roll back organization features using the state captured during deploy. Deploy
 * changes features in place, so rollback restores exactly the features this deploy
 * changed to their prior value (read-modify-write PUT of the features resource).
 * Features that were already in the desired state are left untouched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as FeatureRollbackData | undefined)?.previousState ?? []
  if (previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy changed no features.' }
  }

  try {
    const features = await getFeatures(client)
    const merged: Record<string, unknown> = { ...features }
    for (const entry of previousState) {
      merged[entry.feature] = entry.existed ? entry.prior : false
    }

    const res = await client.request('PUT', `${client.orgPath}/features`, { body: merged })
    if (!res.ok) throw new Error(`Failed to update organization features: ${ppErrorMessage(res)}`)

    const restored = previousState.map((e) => `${e.feature}=${e.existed ? e.prior : false}`)
    return { success: true, message: `Rolled back ${previousState.length} feature(s): ${restored.join(', ')}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
