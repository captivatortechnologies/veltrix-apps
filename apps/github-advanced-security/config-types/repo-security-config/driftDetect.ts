import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import {
  desiredFromItem,
  parseRepository,
  securityAndAnalysisState,
  defaultSetupEnabled,
  type RepoResponse,
  type AutomatedSecurityFixes,
  type CodeScanningDefaultSetup,
} from './_shared'

/**
 * Drift for repository security: compare each declared feature against its live
 * state in GitHub. Read-only — GET /repos, GET automated-security-fixes, GET
 * code-scanning/default-setup. Best-effort: a repo that can't be read (missing /
 * transient error) is skipped rather than raising false drift.
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
    const sa = securityAndAnalysisState(parseJson<RepoResponse>(repoRes.body)?.security_and_analysis)

    const fixesRes = await client.getAutomatedSecurityFixes(owner, repo)
    const dependabotActual = fixesRes.ok ? parseJson<AutomatedSecurityFixes>(fixesRes.body)?.enabled === true : false

    const setupRes = await client.getCodeScanningDefaultSetup(owner, repo)
    const codeScanningActual = setupRes.ok ? defaultSetupEnabled(parseJson<CodeScanningDefaultSetup>(setupRes.body)) : false

    const checks: Array<{ field: string; expected: boolean; actual: boolean }> = [
      { field: 'advanced_security', expected: desired.advanced_security, actual: sa.advanced_security },
      { field: 'secret_scanning', expected: desired.secret_scanning, actual: sa.secret_scanning },
      {
        field: 'secret_scanning_push_protection',
        expected: desired.secret_scanning_push_protection,
        actual: sa.secret_scanning_push_protection,
      },
      { field: 'dependabot_security_updates', expected: desired.dependabot_security_updates, actual: dependabotActual },
      { field: 'code_scanning_default_setup', expected: desired.code_scanning_default_setup, actual: codeScanningActual },
    ]

    for (const check of checks) {
      if (check.actual !== check.expected) {
        diffs.push({
          field: `${fullName}.${check.field}`,
          expected: check.expected,
          actual: check.actual,
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
