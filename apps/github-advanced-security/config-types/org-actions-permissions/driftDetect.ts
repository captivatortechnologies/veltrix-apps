import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, type OrgActionsPermissions, type OrgActionsAllowedActions, type OrgActionsWorkflowPermissions } from './_shared'

/**
 * Drift for the org Actions policy: compare each declared organization's
 * settings against its live state. Read-only — GET the four permissions
 * endpoints. Best-effort: an org whose base permissions can't be read is
 * skipped rather than raising false drift.
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
    if (!desired.org) continue

    const permRes = await client.getOrgActionsPermissions(desired.org)
    if (!permRes.ok) continue // best-effort: can't read, assert no drift
    const perm = parseJson<OrgActionsPermissions>(permRes.body) ?? {}

    if ((perm.enabled_repositories ?? 'all') !== desired.enabledRepositories) {
      diffs.push({ field: `${desired.org}.enabled_repositories`, expected: desired.enabledRepositories, actual: perm.enabled_repositories ?? 'all', severity: 'warning' })
    }
    if ((perm.allowed_actions ?? 'all') !== desired.allowedActions) {
      diffs.push({ field: `${desired.org}.allowed_actions`, expected: desired.allowedActions, actual: perm.allowed_actions ?? 'all', severity: 'warning' })
    }
    if (Boolean(perm.sha_pinning_required) !== desired.shaPinningRequired) {
      diffs.push({ field: `${desired.org}.sha_pinning_required`, expected: desired.shaPinningRequired, actual: Boolean(perm.sha_pinning_required), severity: 'warning' })
    }

    if (desired.allowedActions === 'selected') {
      const allowedRes = await client.getOrgActionsAllowedActions(desired.org)
      if (allowedRes.ok) {
        const allowed = parseJson<OrgActionsAllowedActions>(allowedRes.body) ?? {}
        if (Boolean(allowed.github_owned_allowed) !== desired.githubOwnedAllowed) {
          diffs.push({ field: `${desired.org}.github_owned_allowed`, expected: desired.githubOwnedAllowed, actual: Boolean(allowed.github_owned_allowed), severity: 'warning' })
        }
        if (Boolean(allowed.verified_allowed) !== desired.verifiedAllowed) {
          diffs.push({ field: `${desired.org}.verified_allowed`, expected: desired.verifiedAllowed, actual: Boolean(allowed.verified_allowed), severity: 'warning' })
        }
      }
    }

    const workflowRes = await client.getOrgActionsWorkflowPermissions(desired.org)
    if (workflowRes.ok) {
      const workflow = parseJson<OrgActionsWorkflowPermissions>(workflowRes.body) ?? {}
      if ((workflow.default_workflow_permissions ?? 'read') !== desired.defaultWorkflowPermissions) {
        diffs.push({
          field: `${desired.org}.default_workflow_permissions`,
          expected: desired.defaultWorkflowPermissions,
          actual: workflow.default_workflow_permissions ?? 'read',
          severity: 'warning',
        })
      }
      if (Boolean(workflow.can_approve_pull_request_reviews) !== desired.canApprovePullRequestReviews) {
        diffs.push({
          field: `${desired.org}.can_approve_pull_request_reviews`,
          expected: desired.canApprovePullRequestReviews,
          actual: Boolean(workflow.can_approve_pull_request_reviews),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
