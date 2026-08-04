import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import type { AutolinkRollbackEntry } from './_shared'

/**
 * Undo a repo-autolinks deploy from rollbackData.entries (written by
 * deploy()):
 *   - an autolink that existed before is recreated from its prior shape
 *     (delete the current id, then POST the prior key_prefix/url_template/
 *     is_alphanumeric — GitHub assigns it a new id).
 *   - an autolink THIS deploy created is deleted.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { entries?: AutolinkRollbackEntry[] }
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
    const parts = entry.repository.split('/')
    if (parts.length !== 2) continue
    const [owner, repo] = parts

    try {
      if (entry.existed && entry.prior) {
        const del = await client.deleteAutolink(owner, repo, entry.id)
        if (!del.ok && del.status !== 404) throw new Error(`delete: ${del.status} ${githubErrorMessage(del)}`)
        const create = await client.createAutolink(owner, repo, {
          key_prefix: entry.prior.key_prefix,
          url_template: entry.prior.url_template,
          is_alphanumeric: entry.prior.is_alphanumeric ?? true,
        })
        if (!create.ok) throw new Error(`recreate: ${create.status} ${githubErrorMessage(create)}`)
        restored++
      } else if (!entry.existed) {
        const del = await client.deleteAutolink(owner, repo, entry.id)
        if (!del.ok && del.status !== 404) throw new Error(`delete: ${del.status} ${githubErrorMessage(del)}`)
        deleted++
      }
    } catch (error) {
      failures.push(`${entry.repository}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rolled back ${restored} restored / ${deleted} deleted; ${failures.length} failed: ${failures.join(' | ')}`,
    }
  }
  return { success: true, message: `Rolled back autolinks: ${restored} restored, ${deleted} deleted.` }
}
