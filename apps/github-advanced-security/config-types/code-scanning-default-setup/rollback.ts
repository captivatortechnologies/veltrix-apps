import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import { restoreBody } from './_shared'
import type { DefaultSetupRollbackEntry } from './deploy'

/**
 * Undo a code-scanning-default-setup deploy from rollbackData.previous
 * (written by deploy()): PATCH each repository's default-setup configuration
 * back to its prior state. There is no create/delete concept for this
 * endpoint — the configuration always exists, only its `state` toggles.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: DefaultSetupRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  const failures: string[] = []

  for (const entry of previous) {
    const parts = entry.repository.split('/')
    if (parts.length !== 2) continue
    const [owner, repo] = parts

    try {
      const res = await client.updateCodeScanningDefaultSetup(owner, repo, restoreBody(entry.prior))
      if (!res.ok) throw new Error(`default-setup: ${res.status} ${githubErrorMessage(res)}`)
      restored++
    } catch (error) {
      failures.push(`${entry.repository}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rolled back ${restored} repo(s); ${failures.length} failed: ${failures.join(' | ')}` }
  }
  return { success: true, message: `Rolled back code scanning default setup: ${restored} repo(s) restored.` }
}
