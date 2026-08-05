import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'
import type { FirewallRuleRollbackEntry } from './deploy'

/**
 * Roll back Firewall Control rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /firewall-control)
 *   - rules that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? 'scope not configured' }
  const filter = sf.filter

  const previousState = (ctx.rollbackData as { previousState?: FirewallRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', '/firewall-control', { body: { data: { ids: [entry.id] } } })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete firewall rule "${entry.label}": ${s1ErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: p.name,
          description: p.description ?? '',
          action: p.action,
          direction: p.direction,
          osType: p.osType,
          protocol: p.protocol ?? '',
          application: p.application ?? '',
          service: p.service ?? '',
          status: p.status,
        }
        const res = await client.request('PUT', '/firewall-control', { body: { filter, data: restore } })
        if (!res.ok) {
          throw new Error(`Failed to restore firewall rule "${entry.label}": ${s1ErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} firewall rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
