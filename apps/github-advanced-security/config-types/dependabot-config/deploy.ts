import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson, type GithubClient } from '../../lib/githubApi'
import {
  desiredFromItem,
  parseRepository,
  type AutomatedSecurityFixes,
  type DependabotPreviousState,
} from './_shared'

/**
 * Deploy Dependabot posture per repository over the REST API:
 *   read (rollback): GET /repos/{owner}/{repo}                          (readability gate)
 *                    GET /repos/{owner}/{repo}/vulnerability-alerts     (204 enabled / 404 disabled)
 *                    GET /repos/{owner}/{repo}/automated-security-fixes ({ enabled })
 *   apply:           PUT|DELETE /repos/{owner}/{repo}/vulnerability-alerts
 *                    PUT|DELETE /repos/{owner}/{repo}/automated-security-fixes
 *
 * Alerts are applied before security updates so enabling both in one deploy
 * satisfies GitHub's ordering (security updates require alerts). A repo the token
 * cannot read (404/403) is skipped rather than failing the whole deploy.
 * rollbackData records the prior state of both features per repository.
 */

/** Read the current Dependabot state for one repo (for rollback + skip decisions). */
async function readPrevious(
  client: GithubClient,
  owner: string,
  repo: string,
): Promise<{ previous: DependabotPreviousState; readable: true } | { readable: false; reason: string }> {
  const repoRes = await client.getRepo(owner, repo)
  if (!repoRes.ok) {
    return { readable: false, reason: `${repoRes.status} ${githubErrorMessage(repoRes)}` }
  }

  const alertsRes = await client.getVulnerabilityAlerts(owner, repo)
  const alertsEnabled = alertsRes.status === 204

  const fixesRes = await client.getAutomatedSecurityFixes(owner, repo)
  const fixes = fixesRes.ok ? parseJson<AutomatedSecurityFixes>(fixesRes.body) : null

  return {
    readable: true,
    previous: {
      repository: `${owner}/${repo}`,
      vulnerability_alerts: alertsEnabled,
      security_updates: fixes?.enabled === true,
    },
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: DependabotPreviousState[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)
    if (!parsed) {
      skipped.push(desired.repository || '(blank)')
      continue
    }
    const { owner, repo } = parsed
    const fullName = `${owner}/${repo}`

    const prior = await readPrevious(client, owner, repo)
    if (!prior.readable) {
      skipped.push(`${fullName} (${prior.reason})`)
      continue
    }
    previous.push(prior.previous)

    try {
      // Alerts first: enabling security updates requires alerts to be on.
      const alertsRes = await client.setVulnerabilityAlerts(owner, repo, desired.vulnerability_alerts)
      if (!alertsRes.ok) throw new Error(`vulnerability-alerts: ${alertsRes.status} ${githubErrorMessage(alertsRes)}`)

      const fixesRes = await client.setAutomatedSecurityFixes(owner, repo, desired.security_updates)
      if (!fixesRes.ok) throw new Error(`automated-security-fixes: ${fixesRes.status} ${githubErrorMessage(fixesRes)}`)

      applied.push(fullName)
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} repo(s); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { previous },
    }
  }
  return {
    success: true,
    message: `Applied Dependabot posture to ${applied.length} repo(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { previous },
  }
}
