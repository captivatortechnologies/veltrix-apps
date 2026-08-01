import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, type AutomatedSecurityFixes } from './_shared'

/**
 * Drift for Dependabot posture: compare each declared feature against its live
 * state in GitHub. Read-only — GET /repos (readability gate), GET
 * vulnerability-alerts (204 enabled / 404 disabled), GET automated-security-fixes.
 * Best-effort: a repo that can't be read is skipped rather than raising false
 * drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)
    if (!parsed) continue
    const { owner, repo } = parsed
    const fullName = `${owner}/${repo}`

    const repoRes = await client.getRepo(owner, repo)
    if (!repoRes.ok) continue // best-effort: can't read the repo, assert no drift

    const alertsRes = await client.getVulnerabilityAlerts(owner, repo)
    const alertsActual = alertsRes.status === 204

    const fixesRes = await client.getAutomatedSecurityFixes(owner, repo)
    const updatesActual = fixesRes.ok ? parseJson<AutomatedSecurityFixes>(fixesRes.body)?.enabled === true : false

    const checks: Array<{ field: string; expected: boolean; actual: boolean }> = [
      { field: 'vulnerability_alerts', expected: desired.vulnerability_alerts, actual: alertsActual },
      { field: 'security_updates', expected: desired.security_updates, actual: updatesActual },
    ]

    for (const check of checks) {
      if (check.actual !== check.expected) {
        diffs.push({ field: `${fullName}.${check.field}`, expected: check.expected, actual: check.actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
