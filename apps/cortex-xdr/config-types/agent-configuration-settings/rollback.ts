import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { SCALAR_SETTING_GROUPS, ACTION_CENTER_EXPIRATION_SET_PATH } from './_shared'

/**
 * Restore Cortex XDR agent configuration settings to their prior values: every
 * scalar setting group is SET back to its recorded prior GET response, and only
 * the action-type keys this deploy actually touched are restored (never
 * touching, let alone clearing, an action type outside that set — see
 * _shared.ts for why action_center_expiration is a partial merge).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    priorByGroup?: Record<string, Record<string, unknown> | null>
    touchedActionKeys?: string[]
    priorActionValues?: Record<string, number>
  }
  const priorByGroup = data.priorByGroup ?? {}
  if (Object.keys(priorByGroup).length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for agent-configuration-settings rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restored: string[] = []

  try {
    for (const group of SCALAR_SETTING_GROUPS) {
      const prior = priorByGroup[group.key]
      if (!prior) continue
      const res = await client.call(group.setPath, prior)
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback failed for "${group.key}": ${error}` }
      restored.push(group.key)
    }

    const touchedActionKeys = data.touchedActionKeys ?? []
    if (touchedActionKeys.length > 0) {
      const priorActionValues = data.priorActionValues ?? {}
      const requestData: Record<string, number> = {}
      for (const key of touchedActionKeys) {
        if (typeof priorActionValues[key] === 'number') requestData[key] = priorActionValues[key]
      }
      if (Object.keys(requestData).length > 0) {
        const res = await client.call(ACTION_CENTER_EXPIRATION_SET_PATH, requestData)
        const error = cortexWriteError(res)
        if (error) return { success: false, message: `Rollback failed for "action_center_expiration": ${error}` }
        restored.push('action_center_expiration')
      }
    }

    return { success: true, message: `Rolled back agent configuration settings: ${restored.join(', ') || '(none)'}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
