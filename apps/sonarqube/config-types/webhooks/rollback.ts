import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { webhooksFromList, findWebhook, type SonarWebhook } from './_shared'

/**
 * Undo a webhooks deploy from rollbackData (written by deploy()):
 *   - a webhook we CREATED (existed=false) is deleted (POST /api/webhooks/delete).
 *   - a webhook that already EXISTED has its url restored (POST /api/webhooks/update to
 *     the recorded prior url). The key is re-resolved from the list when missing.
 * Best-effort — a failure on one webhook does not abort the rest.
 *
 * NOTE: SonarQube never returns a webhook secret, so a secret changed by the deploy
 * cannot be restored to its prior value here.
 */
const enc = encodeURIComponent

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    webhooks?: Array<{ name: string; project: string; existed: boolean; key: string; priorUrl: string; priorHadSecret: boolean }>
  }
  const webhooks = data.webhooks ?? []
  if (webhooks.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for webhook rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const listCache = new Map<string, SonarWebhook[]>()
  async function keyOf(name: string, project: string, fallback: string): Promise<string> {
    if (fallback) return fallback
    if (!listCache.has(project)) {
      const suffix = project ? `?project=${enc(project)}` : ''
      try {
        listCache.set(project, webhooksFromList(await getJson<unknown>(`${base}/api/webhooks/list${suffix}`, headers)))
      } catch {
        listCache.set(project, [])
      }
    }
    const match = findWebhook(listCache.get(project)!, name)
    return match?.key ? String(match.key) : ''
  }

  let removed = 0
  let restored = 0
  const failures: string[] = []

  for (const webhook of webhooks) {
    try {
      const key = await keyOf(webhook.name, webhook.project, webhook.key)
      if (!webhook.existed) {
        if (key) {
          await postForm(`${base}/api/webhooks/delete`, headers, { webhook: key })
          removed++
        }
        continue
      }
      if (key && webhook.priorUrl) {
        await postForm(`${base}/api/webhooks/update`, headers, { webhook: key, name: webhook.name, url: webhook.priorUrl })
        restored++
      }
    } catch (error) {
      failures.push(`${webhook.name}: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${removed} removed, ${restored} restored. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back webhooks: ${removed} removed, ${restored} restored.` }
}
