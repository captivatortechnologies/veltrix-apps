import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  SCALAR_SETTING_GROUPS,
  ACTION_CENTER_EXPIRATION_GET_PATH,
  ACTION_CENTER_EXPIRATION_SET_PATH,
  buildScalarGroupRequest,
  scalarGroupFromReply,
  parseActionCenterExpiration,
} from './_shared'

/**
 * Deploy Cortex XDR agent configuration settings — a tenant-wide singleton of 9
 * GET/SET boolean+integer setting groups (each "owned outright": every deploy
 * re-applies the full declared value) plus one genuine partial-merge keyvalue
 * map (action_center_expiration, where only the action types present on the
 * canvas are ever touched — see _shared.ts). rollbackData records, per group,
 * the prior GET response (and, for action_center_expiration, the prior value of
 * only the touched keys) so rollback can restore exactly what changed.
 *
 * VERIFY every endpoint path + field name against a live Cortex XDR tenant.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) {
    return { success: true, message: 'No agent configuration settings configured.', rollbackData: {} }
  }

  if (!credential) {
    return { success: false, message: 'Missing credential for agent-configuration-settings deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client }: { client: CortexXdrClient } = built

  const priorByGroup: Record<string, unknown> = {}
  const applied: string[] = []

  try {
    for (const group of SCALAR_SETTING_GROUPS) {
      const priorRes = await client.call(group.getPath, {})
      priorByGroup[group.key] = priorRes.ok ? scalarGroupFromReply(priorRes.reply) : null

      const body = buildScalarGroupRequest(group, item.fields)
      const res = await client.call(group.setPath, body)
      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `Agent-configuration-settings deploy failed for "${group.key}": ${error}`,
          artifacts: { applied },
          rollbackData: { priorByGroup, touchedActionKeys: [] },
        }
      }
      applied.push(group.key)
    }

    const touchedActionKeys = Object.keys(parseActionCenterExpiration(item.fields.action_center_expiration))
    const priorActionValues: Record<string, number> = {}
    if (touchedActionKeys.length > 0) {
      const priorRes = await client.call(ACTION_CENTER_EXPIRATION_GET_PATH, {})
      const liveMap = priorRes.ok ? scalarGroupFromReply(priorRes.reply) : {}
      for (const key of touchedActionKeys) {
        const value = liveMap[key]
        if (typeof value === 'number') priorActionValues[key] = value
      }

      const requestData = parseActionCenterExpiration(item.fields.action_center_expiration)
      const res = await client.call(ACTION_CENTER_EXPIRATION_SET_PATH, requestData)
      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `Agent-configuration-settings deploy failed for "action_center_expiration": ${error}`,
          artifacts: { applied },
          rollbackData: { priorByGroup, touchedActionKeys, priorActionValues },
        }
      }
      applied.push('action_center_expiration')
    }

    return {
      success: true,
      message: `Applied agent configuration settings: ${applied.join(', ')}.`,
      artifacts: { applied },
      rollbackData: { priorByGroup, touchedActionKeys, priorActionValues },
    }
  } catch (error) {
    return {
      success: false,
      message: `Agent-configuration-settings deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { priorByGroup, touchedActionKeys: [] },
    }
  }
}
