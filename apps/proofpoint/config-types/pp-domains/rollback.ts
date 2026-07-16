import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import type { DomainRollbackEntry } from './deploy'

/**
 * Roll back domains using the state captured during deploy:
 *   - domains that were created are deleted (DELETE /orgs/{org}/domains/{name})
 *   - domains that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DomainRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const domainPath = `${client.orgPath}/domains/${encodeURIComponent(entry.name)}`
      if (!entry.existed) {
        const res = await client.request('DELETE', domainPath)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete domain "${entry.name}": ${ppErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name ?? entry.name,
          is_active: p.is_active ?? true,
          is_relay: p.is_relay ?? false,
          destination: p.destination ?? '',
          failovers: Array.isArray(p.failovers) ? p.failovers : [],
        }
        const res = await client.request('PUT', domainPath, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore domain "${entry.name}": ${ppErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} domain(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
