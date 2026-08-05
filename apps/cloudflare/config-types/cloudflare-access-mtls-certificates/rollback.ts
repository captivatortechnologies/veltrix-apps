import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { MtlsCertificateRollbackEntry } from './deploy'

/**
 * Roll back Access mTLS certificates using the state captured during deploy:
 *   - certificates that were created are deleted (DELETE /access/certificates/{id})
 *   - certificates that were updated have their name/associated_hostnames
 *     restored (PUT) — the certificate PEM content is immutable and was never
 *     changed by an update in the first place
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MtlsCertificateRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `/access/certificates/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete mTLS certificate "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const res = await client.account('PUT', `/access/certificates/${entry.id}`, {
          body: { name: p.name ?? entry.label, associated_hostnames: p.associated_hostnames ?? [] },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore mTLS certificate "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} mTLS certificate(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} certificate(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
