import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { attributesToBody, toPayload } from './_shared'
import { readSecurityFilter, type SecurityFilterRollbackEntry } from './deploy'

const FILTERS_PATH = '/api/v2/security_monitoring/configuration/security_filters'

/**
 * Roll back Security Filters using the state captured during deploy:
 *   - filters that were CREATED are deleted (DELETE .../{id}; 404 tolerated)
 *   - filters that were UPDATED are restored (PATCH) to their captured prior
 *     attributes. The version has advanced since deploy wrote it, so the
 *     CURRENT version is re-read immediately before restoring — the
 *     originally captured version is used only as a best-effort fallback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SecurityFilterRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${FILTERS_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete filter "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior?.attributes) {
        let version = entry.prior.attributes.version
        try {
          const fresh = await readSecurityFilter(client, entry.id)
          if (typeof fresh.attributes?.version === 'number') version = fresh.attributes.version
        } catch {
          // Best-effort — fall back to the version captured at deploy time.
        }

        const body = attributesToBody(entry.prior.attributes, version)
        const res = await client.request('PATCH', `${FILTERS_PATH}/${encodeURIComponent(entry.id)}`, { body: toPayload(body) })
        if (!res.ok) throw new Error(`Failed to restore filter "${entry.label}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Security Filter(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
