import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import type { OutboundPortRollbackEntry } from './deploy'

/**
 * Roll back outbound port changes using the delta captured during deploy:
 *   - subnets the deployment added are removed
 *   - subnets the deployment removed are restored
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: OutboundPortRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const reverted: number[] = []

  try {
    for (const entry of previousState) {
      if (entry.added.length > 0) {
        const res = await acsRequest(acs, 'DELETE', `/access/outbound-ports/${entry.port}`, {
          subnets: entry.added,
        })
        if (res.status !== 200 && res.status !== 202) {
          throw new Error(`Failed to remove added destinations from port ${entry.port}: ${acsErrorMessage(res)}`)
        }
      }

      if (entry.removed.length > 0) {
        const res = await acsRequest(acs, 'POST', '/access/outbound-ports', {
          outboundPorts: [{ port: entry.port, subnets: entry.removed }],
          reason: 'veltrix rollback',
        })
        if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
          throw new Error(`Failed to restore removed destinations to port ${entry.port}: ${acsErrorMessage(res)}`)
        }
      }

      reverted.push(entry.port)
    }

    return {
      success: true,
      message: `Rolled back outbound port changes for ${reverted.length} port(s) on stack "${stack}": ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} port(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
