import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson } from '../../lib/githubApi'
import {
  desiredFromItem,
  buildPermissionsBody,
  buildSelectedRepositoriesBody,
  buildAllowedActionsBody,
  buildWorkflowBody,
  type OrgActionsPermissions,
  type OrgActionsSelectedRepositories,
  type OrgActionsAllowedActions,
  type OrgActionsWorkflowPermissions,
  type OrgActionsPermissionsPrevious,
} from './_shared'

/**
 * Deploy the GitHub Actions organization policy over the REST API:
 *   read:  GET /orgs/{org}/actions/permissions[/repositories|/selected-actions|/workflow]
 *   apply: PUT the same four endpoints, in order — base permissions first (so
 *          "selected" mode exists before its sub-lists are set), then the two
 *          conditional sub-lists, then workflow permissions.
 *
 * The organization login is the stable identity. An org the token cannot read
 * (404/403 — insufficient admin:org scope) is skipped rather than failing the
 * whole deploy. rollbackData records, per org, the prior state of all four
 * endpoints so rollback can restore them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: OrgActionsPermissionsPrevious[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org) {
      skipped.push('(no org)')
      continue
    }

    const permRes = await client.getOrgActionsPermissions(desired.org)
    if (!permRes.ok) {
      skipped.push(`${desired.org} (${permRes.status} ${githubErrorMessage(permRes)})`)
      continue
    }
    const priorPermissions = parseJson<OrgActionsPermissions>(permRes.body) ?? {}

    const priorSelectedRes = priorPermissions.enabled_repositories === 'selected' ? await client.getOrgActionsSelectedRepositories(desired.org) : null
    const priorSelected = priorSelectedRes?.ok
      ? (parseJson<OrgActionsSelectedRepositories>(priorSelectedRes.body)?.repositories ?? []).map((r) => r.id)
      : null

    const priorAllowedRes = priorPermissions.allowed_actions === 'selected' ? await client.getOrgActionsAllowedActions(desired.org) : null
    const priorAllowed = priorAllowedRes?.ok ? parseJson<OrgActionsAllowedActions>(priorAllowedRes.body) : null

    const workflowRes = await client.getOrgActionsWorkflowPermissions(desired.org)
    const priorWorkflow = workflowRes.ok ? parseJson<OrgActionsWorkflowPermissions>(workflowRes.body) ?? {} : {}

    previous.push({ org: desired.org, permissions: priorPermissions, selectedRepositoryIds: priorSelected, allowedActions: priorAllowed, workflow: priorWorkflow })

    try {
      const setPerm = await client.setOrgActionsPermissions(desired.org, buildPermissionsBody(desired))
      if (!setPerm.ok) throw new Error(`permissions: ${setPerm.status} ${githubErrorMessage(setPerm)}`)

      if (desired.enabledRepositories === 'selected') {
        const setSelected = await client.setOrgActionsSelectedRepositories(desired.org, buildSelectedRepositoriesBody(desired))
        if (!setSelected.ok) throw new Error(`selected-repositories: ${setSelected.status} ${githubErrorMessage(setSelected)}`)
      }

      if (desired.allowedActions === 'selected') {
        const setAllowed = await client.setOrgActionsAllowedActions(desired.org, buildAllowedActionsBody(desired))
        if (!setAllowed.ok) throw new Error(`selected-actions: ${setAllowed.status} ${githubErrorMessage(setAllowed)}`)
      }

      const setWorkflow = await client.setOrgActionsWorkflowPermissions(desired.org, buildWorkflowBody(desired))
      if (!setWorkflow.ok) throw new Error(`workflow: ${setWorkflow.status} ${githubErrorMessage(setWorkflow)}`)

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
    message: `Applied Actions permissions to ${applied.length} org(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { previous },
  }
}
