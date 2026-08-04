import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, liveState, type RepoResponse } from './_shared'

/**
 * Drift for secret scanning options: compare each declared repository's five
 * advanced sub-settings against their live state. Read-only — GET
 * /repos/{owner}/{repo}. Best-effort: a repo that can't be read is skipped
 * rather than raising false drift. Delegated-bypass reviewers are not diffed
 * (GitHub's read shape for reviewers is not guaranteed stable across API
 * versions); only the on/off state of delegated bypass itself is compared.
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

    const res = await client.getRepo(owner, repo)
    if (!res.ok) continue // best-effort: can't read the repo, assert no drift
    const live = liveState(parseJson<RepoResponse>(res.body)?.security_and_analysis)

    const checks: Array<{ field: string; expected: boolean; actual: boolean }> = [
      { field: 'secret_scanning_validity_checks', expected: desired.validityChecks, actual: live.validityChecks },
      { field: 'secret_scanning_non_provider_patterns', expected: desired.nonProviderPatterns, actual: live.nonProviderPatterns },
      { field: 'secret_scanning_ai_detection', expected: desired.aiDetection, actual: live.aiDetection },
      { field: 'secret_scanning_delegated_alert_dismissal', expected: desired.delegatedAlertDismissal, actual: live.delegatedAlertDismissal },
      { field: 'secret_scanning_delegated_bypass', expected: desired.delegatedBypass, actual: live.delegatedBypass },
    ]

    for (const check of checks) {
      if (check.actual !== check.expected) {
        diffs.push({ field: `${fullName}.${check.field}`, expected: check.expected, actual: check.actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
