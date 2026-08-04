import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson } from '../../lib/githubApi'
import { desiredFromItem, buildOrgPatch, type OrgMemberPrivileges, type OrgMemberPrivilegesPrevious } from './_shared'

/**
 * Deploy organization member privileges over the REST API:
 *   read:  GET   /orgs/{org}
 *   apply: PATCH /orgs/{org}   (member-privilege fields only)
 *
 * The organization login is the stable identity. An org the token cannot read
 * (404/403) is skipped rather than failing the whole deploy. rollbackData
 * records, per org, the prior privileges so rollback can restore them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: OrgMemberPrivilegesPrevious[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org) {
      skipped.push('(no org)')
      continue
    }

    const getRes = await client.getOrg(desired.org)
    if (!getRes.ok) {
      skipped.push(`${desired.org} (${getRes.status} ${githubErrorMessage(getRes)})`)
      continue
    }
    const prior = parseJson<OrgMemberPrivileges>(getRes.body) ?? {}
    previous.push({ org: desired.org, prior })

    try {
      const res = await client.updateOrg(desired.org, buildOrgPatch(desired))
      if (!res.ok) throw new Error(`update org: ${res.status} ${githubErrorMessage(res)}`)
      applied.push(desired.org)
    } catch (error) {
      failures.push(`${desired.org}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} org(s); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { previous },
    }
  }
  return {
    success: true,
    message: `Applied member privileges to ${applied.length} org(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { previous },
  }
}
