import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { ProvisioningKeyRollbackEntry } from './deploy'
import { DEFAULT_MAX_USAGE } from './validate'

/**
 * Roll back ZPA provisioning keys using the state captured during deploy:
 *   - keys that were created are deleted (DELETE .../provisioningKey/{id})
 *   - keys that were updated are restored (PUT) to their prior scalar body
 * The CRUD collection is parameterized by association type, so each entry carries
 * its `associationType` and the path is rebuilt per entry. ZPA changes are
 * immediate, so no activation is needed.
 *
 * ⚠ The key SECRET is neither needed nor available here — an update PUT carries
 * only the managed scalar fields; the generated key value stays untouched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProvisioningKeyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const base = `/associationType/${entry.associationType}/provisioningKey`

      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zpa('DELETE', `${base}/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete provisioning key "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.prior.name ?? entry.name,
          maxUsage: String(entry.prior.maxUsage ?? DEFAULT_MAX_USAGE),
          enabled: entry.prior.enabled ?? true,
          zcomponentId: entry.prior.zcomponentId ?? '',
          enrollmentCertId: entry.prior.enrollmentCertId ?? '',
        }
        const res = await client.zpa('PUT', `${base}/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore provisioning key "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ZPA provisioning key(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} key(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
