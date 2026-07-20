import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type ThreatInsightRollbackData } from './deploy'

/**
 * Roll back the org ThreatInsight configuration by replaying the prior config
 * captured during deploy (a full replace via POST /threats/configuration). There
 * is nothing to create or delete — the singleton always exists.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const prior = (ctx.rollbackData as ThreatInsightRollbackData)?.prior
  if (!prior) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  try {
    const res = await client.request('POST', '/threats/configuration', {
      body: { action: prior.action, excludeZones: prior.excludeZones },
    })
    if (!res.ok) {
      throw new Error(`Failed to restore ThreatInsight configuration: ${oktaErrorMessage(res)}`)
    }
    return {
      success: true,
      message: `Restored ThreatInsight configuration: action=${prior.action}, ${prior.excludeZones.length} exempt zone(s)`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
