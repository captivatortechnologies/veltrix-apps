import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import { restorePatch, type SecretScanningOptionsPrevious } from './_shared'

/**
 * Undo a secret-scanning-options deploy from rollbackData.previous (written by
 * deploy()): PATCH each repository's `security_and_analysis` back to its prior
 * state for this type's five sub-keys only — other config types' keys on the
 * same object are left untouched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: SecretScanningOptionsPrevious[] }
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
      const res = await client.updateRepo(owner, repo, restorePatch(entry.block))
      if (!res.ok) throw new Error(`security_and_analysis: ${res.status} ${githubErrorMessage(res)}`)
      restored++
    } catch (error) {
      failures.push(`${entry.repository}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rolled back ${restored} repo(s); ${failures.length} failed: ${failures.join(' | ')}` }
  }
  return { success: true, message: `Rolled back secret scanning options: ${restored} repo(s) restored.` }
}
