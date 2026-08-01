import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import { buildSecurityAndAnalysisPatch, buildDefaultSetupPatch, type RepoPreviousState } from './_shared'

/**
 * Undo a repository-security deploy from rollbackData.previous (written by
 * deploy()): for each repository, re-apply the prior state of every feature over
 * the GitHub REST API — security_and_analysis (PATCH /repos), Dependabot security
 * updates (PUT|DELETE automated-security-fixes) and code-scanning default setup
 * (PATCH default-setup).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RepoPreviousState[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  const failures: string[] = []

  for (const prev of previous) {
    const parts = prev.repository.split('/')
    if (parts.length !== 2) continue
    const [owner, repo] = parts

    try {
      const saRes = await client.updateRepo(owner, repo, buildSecurityAndAnalysisPatch(prev))
      if (!saRes.ok) throw new Error(`security_and_analysis: ${saRes.status} ${githubErrorMessage(saRes)}`)

      const fixesRes = await client.setAutomatedSecurityFixes(owner, repo, prev.dependabot_security_updates)
      if (!fixesRes.ok) throw new Error(`automated-security-fixes: ${fixesRes.status} ${githubErrorMessage(fixesRes)}`)

      const setupRes = await client.updateCodeScanningDefaultSetup(
        owner,
        repo,
        buildDefaultSetupPatch(prev.code_scanning_default_setup),
      )
      if (!setupRes.ok) throw new Error(`code-scanning default-setup: ${setupRes.status} ${githubErrorMessage(setupRes)}`)

      restored++
    } catch (error) {
      failures.push(`${prev.repository}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rolled back ${restored} repo(s); ${failures.length} failed: ${failures.join(' | ')}` }
  }
  return { success: true, message: `Rolled back GitHub security posture: ${restored} repo(s) restored.` }
}
