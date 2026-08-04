import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, buildProtectionBody, type LiveBranchProtection, type BranchProtectionRollbackEntry } from './_shared'

/**
 * Deploy classic branch protection over the REST API:
 *   read:  GET /repos/{owner}/{repo}/branches/{branch}/protection   (404 = unprotected)
 *   apply: PUT /repos/{owner}/{repo}/branches/{branch}/protection    (full replace)
 *
 * (repository, branch) is the stable identity. A branch that doesn't exist on
 * the repository (404 on GET AND the PUT itself) is skipped rather than
 * failing the whole deploy. rollbackData records, per branch, whether it was
 * protected before this deploy and its prior full shape, so rollback can
 * restore it or remove protection this deploy added.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const entries: BranchProtectionRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)
    const fullName = `${desired.repository || '(blank)'}@${desired.branch || '(no branch)'}`
    if (!parsed || !desired.branch) {
      skipped.push(fullName)
      continue
    }
    const { owner, repo } = parsed

    const { body, errors } = buildProtectionBody(desired)
    if (errors.length > 0) {
      failures.push(`${fullName}: ${errors.join('; ')}`)
      continue
    }

    const getRes = await client.getBranchProtection(owner, repo, desired.branch)
    const existed = getRes.ok
    const prior = existed ? parseJson<LiveBranchProtection>(getRes.body) ?? undefined : undefined
    if (!getRes.ok && getRes.status !== 404) {
      skipped.push(`${fullName} (${getRes.status} ${githubErrorMessage(getRes)})`)
      continue
    }
    entries.push({ repository: `${owner}/${repo}`, branch: desired.branch, existed, prior })

    try {
      const res = await client.updateBranchProtection(owner, repo, desired.branch, body)
      if (!res.ok) throw new Error(`protection: ${res.status} ${githubErrorMessage(res)}`)
      applied.push(fullName)
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} branch(es); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Applied branch protection to ${applied.length} branch(es): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { entries },
  }
}
