import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import type { OrgActionsPermissionsPrevious } from './_shared'

/**
 * Undo an org-actions-permissions deploy from rollbackData.previous (written
 * by deploy()): restore the base permissions, the selected-repositories /
 * selected-actions sub-lists (only when they applied before this deploy) and
 * the workflow permissions, per organization.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: OrgActionsPermissionsPrevious[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  const failures: string[] = []

  for (const entry of previous) {
    try {
      const permRes = await client.setOrgActionsPermissions(entry.org, {
        enabled_repositories: entry.permissions.enabled_repositories ?? 'all',
        allowed_actions: entry.permissions.allowed_actions ?? 'all',
        sha_pinning_required: entry.permissions.sha_pinning_required ?? false,
      })
      if (!permRes.ok) throw new Error(`permissions: ${permRes.status} ${githubErrorMessage(permRes)}`)

      if (entry.permissions.enabled_repositories === 'selected' && entry.selectedRepositoryIds) {
        const res = await client.setOrgActionsSelectedRepositories(entry.org, { selected_repository_ids: entry.selectedRepositoryIds })
        if (!res.ok) throw new Error(`selected-repositories: ${res.status} ${githubErrorMessage(res)}`)
      }

      if (entry.permissions.allowed_actions === 'selected' && entry.allowedActions) {
        const res = await client.setOrgActionsAllowedActions(entry.org, {
          github_owned_allowed: entry.allowedActions.github_owned_allowed ?? true,
          verified_allowed: entry.allowedActions.verified_allowed ?? false,
          patterns_allowed: entry.allowedActions.patterns_allowed ?? [],
        })
        if (!res.ok) throw new Error(`selected-actions: ${res.status} ${githubErrorMessage(res)}`)
      }

      const workflowRes = await client.setOrgActionsWorkflowPermissions(entry.org, {
        default_workflow_permissions: entry.workflow.default_workflow_permissions ?? 'read',
        can_approve_pull_request_reviews: entry.workflow.can_approve_pull_request_reviews ?? false,
      })
      if (!workflowRes.ok) throw new Error(`workflow: ${workflowRes.status} ${githubErrorMessage(workflowRes)}`)

      restored++
    } catch (error) {
      failures.push(`${entry.org}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rolled back ${restored} org(s); ${failures.length} failed: ${failures.join(' | ')}` }
  }
  return { success: true, message: `Rolled back Actions permissions: ${restored} org(s) restored.` }
}
