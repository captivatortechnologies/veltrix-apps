import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { DnsRecordRollbackEntry } from './deploy'

/**
 * Roll back DNS records using the state captured during deploy:
 *   - records that were created are deleted (DELETE /dns_records/{id})
 *   - records that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DnsRecordRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.zone('DELETE', `/dns_records/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete DNS record "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          type: p.type,
          name: p.name,
          content: p.content,
          ttl: p.ttl ?? 1,
        }
        if (p.proxied !== undefined) restore.proxied = p.proxied
        if (p.priority !== undefined) restore.priority = p.priority
        const res = await client.zone('PUT', `/dns_records/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore DNS record "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} DNS record(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} record(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
