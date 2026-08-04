import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import type { AllowedReferrerRollbackEntry } from './deploy'

/**
 * Roll back allowed referrers using the state captured during deploy:
 * deletes every entry THIS DEPLOY created, by id.
 *
 * ⚠ BEST-EFFORT: the DELETE endpoint for a single allowed-referrer entry is
 * not independently confirmed in the sources available to this app (nor is
 * the exact id field name it returns). A delete attempt that fails, or an
 * entry whose id could not be captured, is reported as a WARNING in the
 * result message rather than failing the whole rollback — other entries in
 * the same batch still get their best-effort cleanup attempt. An entry that
 * already existed before this deploy is never touched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AllowedReferrerRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const notCleaned: string[] = []

  for (const entry of [...previousState].reverse()) {
    if (entry.existed) {
      reverted.push(entry.label)
      continue
    }
    if (!entry.id) {
      notCleaned.push(entry.label)
      continue
    }
    const res = await client.request('DELETE', `/Configuration/AccessRestriction/AllowedReferrers/${encodeURIComponent(entry.id)}`)
    if (res.status === 404 || res.ok) {
      reverted.push(entry.label)
    } else {
      notCleaned.push(`${entry.label} (${cyberArkErrorMessage(res)})`)
    }
  }

  await client.logoff()
  const suffix = notCleaned.length
    ? ` — NOTE: ${notCleaned.length} entry(ies) could not be confirmed removed (delete endpoint unverified) and may remain in PVWA: ${notCleaned.join(', ')}`
    : ''
  return { success: true, message: `Rolled back ${reverted.length} of ${previousState.length} allowed referrer(s)${suffix}` }
}
