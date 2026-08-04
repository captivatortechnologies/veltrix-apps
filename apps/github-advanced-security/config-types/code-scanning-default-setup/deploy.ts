import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, buildDefaultSetupPatch, type DefaultSetupConfig } from './_shared'

/**
 * Deploy the full CodeQL code-scanning default-setup configuration per
 * repository over the REST API:
 *   read:  GET   /repos/{owner}/{repo}/code-scanning/default-setup
 *   apply: PATCH /repos/{owner}/{repo}/code-scanning/default-setup
 *
 * The repository full name is the stable identity. A repo whose configuration
 * cannot be read (404/403 — code scanning unavailable, or the token lacks
 * access) is skipped rather than failing the whole deploy. rollbackData
 * records, per repository, the prior configuration so rollback can restore it.
 * GitHub may process the PATCH asynchronously (HTTP 202) when enabling.
 */
export interface DefaultSetupRollbackEntry {
  repository: string
  prior: DefaultSetupConfig
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: DefaultSetupRollbackEntry[] = []
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

    const getRes = await client.getCodeScanningDefaultSetup(owner, repo)
    if (!getRes.ok) {
      skipped.push(`${fullName} (${getRes.status} ${githubErrorMessage(getRes)})`)
      continue
    }
    const prior = parseJson<DefaultSetupConfig>(getRes.body) ?? {}
    previous.push({ repository: fullName, prior })

    try {
      const res = await client.updateCodeScanningDefaultSetup(owner, repo, buildDefaultSetupPatch(desired))
      if (!res.ok) throw new Error(`default-setup: ${res.status} ${githubErrorMessage(res)}`)
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
    message: `Applied code scanning default setup to ${applied.length} repo(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { previous },
  }
}
