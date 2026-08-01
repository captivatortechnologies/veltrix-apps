import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import { type DependabotPreviousState } from './_shared'

/**
 * Undo a Dependabot deploy from rollbackData.previous (written by deploy()): for
 * each repository, re-apply the prior state of both features over the GitHub REST
 * API — Dependabot alerts (PUT|DELETE vulnerability-alerts) and Dependabot
 * security updates (PUT|DELETE automated-security-fixes). Alerts are restored
 * first so restoring an "updates on" state stays valid.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: DependabotPreviousState[] }
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
      const alertsRes = await client.setVulnerabilityAlerts(owner, repo, prev.vulnerability_alerts)
      if (!alertsRes.ok) throw new Error(`vulnerability-alerts: ${alertsRes.status} ${githubErrorMessage(alertsRes)}`)

      const fixesRes = await client.setAutomatedSecurityFixes(owner, repo, prev.security_updates)
      if (!fixesRes.ok) throw new Error(`automated-security-fixes: ${fixesRes.status} ${githubErrorMessage(fixesRes)}`)

      restored++
    } catch (error) {
      failures.push(`${prev.repository}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rolled back ${restored} repo(s); ${failures.length} failed: ${failures.join(' | ')}` }
  }
  return { success: true, message: `Rolled back Dependabot posture: ${restored} repo(s) restored.` }
}
