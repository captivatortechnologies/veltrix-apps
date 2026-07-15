import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'
import { isRuleActive } from './validate'
import { setActivation, type StarRuleRollbackEntry } from './deploy'

/**
 * Roll back STAR rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /cloud-detection/rules)
 *   - rules that were updated are restored (PUT) to their prior body, then
 *     re-enabled/disabled to match their prior Active/Draft status
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

  const previousState = (ctx.rollbackData as { previousState?: StarRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', '/cloud-detection/rules', {
            body: { filter: { ids: [entry.id] } },
          })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete rule "${entry.label}": ${s1ErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name,
          description: p.description ?? '',
          s1ql: p.s1ql,
          queryType: p.queryType,
          severity: p.severity,
          status: 'Draft',
          networkQuarantine: p.networkQuarantine ?? false,
          expirationMode: p.expirationMode ?? 'Permanent',
          queryLang: p.queryLang ?? '2.0',
        }
        if (p.expiration) restore.expiration = p.expiration
        if (p.treatAsThreat && p.treatAsThreat !== 'none') restore.treatAsThreat = p.treatAsThreat
        const res = await client.request('PUT', `/cloud-detection/rules/${encodeURIComponent(entry.id)}`, {
          body: { filter, data: restore },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore rule "${entry.label}": ${s1ErrorMessage(res)}`)
        }
        await setActivation(client, entry.id, isRuleActive(p.status), entry.label)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} STAR rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
