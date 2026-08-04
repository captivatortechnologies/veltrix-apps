import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, buildSecretScanningOptionsPatch, type RepoResponse, type SecretScanningOptionsPrevious } from './_shared'

/**
 * Deploy advanced secret-scanning options per repository over the REST API:
 *   read:  GET   /repos/{owner}/{repo}                (security_and_analysis)
 *   apply: PATCH /repos/{owner}/{repo}                 (security_and_analysis, this type's 5 sub-keys only)
 *
 * The repository full name is the stable identity. A repo the token cannot
 * read (404/403) is skipped rather than failing the whole deploy. rollbackData
 * records, per repository, the prior state of these five sub-keys so rollback
 * can restore them without touching keys other config types manage.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: SecretScanningOptionsPrevious[] = []
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

    const { body, errors } = buildSecretScanningOptionsPatch(desired)
    if (errors.length > 0) {
      failures.push(`${fullName}: ${errors.join('; ')}`)
      continue
    }

    const repoRes = await client.getRepo(owner, repo)
    if (!repoRes.ok) {
      skipped.push(`${fullName} (${repoRes.status} ${githubErrorMessage(repoRes)})`)
      continue
    }
    const sa = parseJson<RepoResponse>(repoRes.body)?.security_and_analysis ?? {}
    previous.push({
      repository: fullName,
      block: {
        secret_scanning_validity_checks: sa.secret_scanning_validity_checks,
        secret_scanning_non_provider_patterns: sa.secret_scanning_non_provider_patterns,
        secret_scanning_ai_detection: sa.secret_scanning_ai_detection,
        secret_scanning_delegated_alert_dismissal: sa.secret_scanning_delegated_alert_dismissal,
        secret_scanning_delegated_bypass: sa.secret_scanning_delegated_bypass,
        secret_scanning_delegated_bypass_options: sa.secret_scanning_delegated_bypass_options,
      },
    })

    try {
      const res = await client.updateRepo(owner, repo, body)
      if (!res.ok) throw new Error(`security_and_analysis: ${res.status} ${githubErrorMessage(res)}`)
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
    message: `Applied secret scanning options to ${applied.length} repo(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { previous },
  }
}
