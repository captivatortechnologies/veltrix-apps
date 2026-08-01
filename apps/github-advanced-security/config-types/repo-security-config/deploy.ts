import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson, type GithubClient } from '../../lib/githubApi'
import {
  desiredFromItem,
  parseRepository,
  buildSecurityAndAnalysisPatch,
  securityAndAnalysisState,
  buildDefaultSetupPatch,
  defaultSetupEnabled,
  type RepoResponse,
  type AutomatedSecurityFixes,
  type CodeScanningDefaultSetup,
  type RepoPreviousState,
} from './_shared'

/**
 * Deploy GitHub Advanced Security posture per repository over the REST API:
 *   read (rollback): GET /repos/{owner}/{repo}                         (security_and_analysis)
 *                    GET /repos/{owner}/{repo}/automated-security-fixes (Dependabot)
 *                    GET /repos/{owner}/{repo}/code-scanning/default-setup
 *   apply:           PATCH /repos/{owner}/{repo}                        (security_and_analysis)
 *                    PUT|DELETE /repos/{owner}/{repo}/automated-security-fixes
 *                    PATCH /repos/{owner}/{repo}/code-scanning/default-setup
 *
 * The repository full name is the stable identity. A repo the token cannot read
 * (404/403) is skipped rather than failing the whole deploy. rollbackData records,
 * per repository, the prior state of all five features so rollback can restore it.
 */

/** Read the current state of all five features for one repo (for rollback + skip decisions). */
async function readPrevious(
  client: GithubClient,
  owner: string,
  repo: string,
): Promise<{ previous: RepoPreviousState; readable: true } | { readable: false; reason: string }> {
  const repoRes = await client.getRepo(owner, repo)
  if (!repoRes.ok) {
    return { readable: false, reason: `${repoRes.status} ${githubErrorMessage(repoRes)}` }
  }
  const repoBody = parseJson<RepoResponse>(repoRes.body)
  const sa = securityAndAnalysisState(repoBody?.security_and_analysis)

  const fixesRes = await client.getAutomatedSecurityFixes(owner, repo)
  const fixes = fixesRes.ok ? parseJson<AutomatedSecurityFixes>(fixesRes.body) : null

  const setupRes = await client.getCodeScanningDefaultSetup(owner, repo)
  const setup = setupRes.ok ? parseJson<CodeScanningDefaultSetup>(setupRes.body) : null

  return {
    readable: true,
    previous: {
      repository: `${owner}/${repo}`,
      advanced_security: sa.advanced_security,
      secret_scanning: sa.secret_scanning,
      secret_scanning_push_protection: sa.secret_scanning_push_protection,
      dependabot_security_updates: fixes?.enabled === true,
      code_scanning_default_setup: defaultSetupEnabled(setup),
    },
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RepoPreviousState[] = []
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
      // 1. security_and_analysis — advanced_security, secret_scanning and push
      // protection in one PATCH (GitHub applies advanced_security first).
      const saRes = await client.updateRepo(owner, repo, buildSecurityAndAnalysisPatch(desired))
      if (!saRes.ok) throw new Error(`security_and_analysis: ${saRes.status} ${githubErrorMessage(saRes)}`)

      // 2. Dependabot security updates.
      const fixesRes = await client.setAutomatedSecurityFixes(owner, repo, desired.dependabot_security_updates)
      if (!fixesRes.ok) throw new Error(`automated-security-fixes: ${fixesRes.status} ${githubErrorMessage(fixesRes)}`)

      // 3. Code scanning default setup (needs advanced security already applied above).
      const setupRes = await client.updateCodeScanningDefaultSetup(
        owner,
        repo,
        buildDefaultSetupPatch(desired.code_scanning_default_setup),
      )
      if (!setupRes.ok) throw new Error(`code-scanning default-setup: ${setupRes.status} ${githubErrorMessage(setupRes)}`)

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
    message: `Applied GitHub security posture to ${applied.length} repo(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { previous },
  }
}
