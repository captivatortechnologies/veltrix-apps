import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import { restoreBody, type OrgWebhookRollbackEntry } from './_shared'

/**
 * Undo an org-webhooks deploy from rollbackData.entries (written by deploy()):
 *   - a webhook that existed before is PATCHed back to its prior non-secret
 *     state (url, content type, SSL verification, events, active). GitHub
 *     never echoes a webhook's secret back, so a secret cannot be restored —
 *     see README Coverage notes.
 *   - a webhook THIS deploy created is deleted.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { entries?: OrgWebhookRollbackEntry[] }
  const entries = data.entries ?? []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  const failures: string[] = []

  for (const entry of entries) {
    if (entry.id == null) continue
    const fullName = `${entry.org} · ${entry.url}`
    try {
      if (entry.existed && entry.prior) {
        const res = await client.updateOrgWebhook(entry.org, entry.id, restoreBody(entry.prior))
        if (!res.ok) throw new Error(`restore: ${res.status} ${githubErrorMessage(res)}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.deleteOrgWebhook(entry.org, entry.id)
        if (!res.ok && res.status !== 404) throw new Error(`delete: ${res.status} ${githubErrorMessage(res)}`)
        deleted++
      }
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rolled back ${restored} restored / ${deleted} deleted; ${failures.length} failed: ${failures.join(' | ')}`,
    }
  }
  return { success: true, message: `Rolled back org webhooks: ${restored} restored, ${deleted} deleted.` }
}
