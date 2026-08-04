import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import {
  desiredFromItem,
  parseRepository,
  parseJsonObject,
  readEnabled,
  normalizeActorSet,
  type LiveBranchProtection,
  type LiveActorSet,
} from './_shared'

/**
 * Drift for classic branch protection: compare each declared branch against
 * its live protection. Read-only — GET the protection endpoint. Best-effort: a
 * repo/branch that can't be read (transient error, not 404) is skipped rather
 * than raising false drift. Actor lists (restrictions, dismissal restrictions,
 * bypass allowances) are compared as normalized login/slug sets — GitHub's GET
 * echoes full user/team/app objects where the PUT only accepts plain strings,
 * so a raw JSON diff would report permanent false drift.
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
    if (!parsed || !desired.branch) continue
    const { owner, repo } = parsed
    const fullName = `${owner}/${repo}@${desired.branch}`

    const res = await client.getBranchProtection(owner, repo, desired.branch)
    if (!res.ok) {
      if (res.status === 404) diffs.push({ field: `${fullName}.exists`, expected: true, actual: false, severity: 'critical' })
      continue // any other failure: best-effort, assert no drift
    }
    const live = parseJson<LiveBranchProtection>(res.body) ?? {}

    // required_status_checks
    if (desired.requireStatusChecks !== Boolean(live.required_status_checks)) {
      diffs.push({ field: `${fullName}.required_status_checks`, expected: desired.requireStatusChecks, actual: Boolean(live.required_status_checks), severity: 'warning' })
    } else if (desired.requireStatusChecks && live.required_status_checks) {
      if (desired.strict !== Boolean(live.required_status_checks.strict)) {
        diffs.push({ field: `${fullName}.strict`, expected: desired.strict, actual: Boolean(live.required_status_checks.strict), severity: 'warning' })
      }
      const liveContexts = [...(live.required_status_checks.contexts ?? [])].sort()
      const desiredContexts = [...desired.contexts].sort()
      if (JSON.stringify(liveContexts) !== JSON.stringify(desiredContexts)) {
        diffs.push({ field: `${fullName}.contexts`, expected: desiredContexts, actual: liveContexts, severity: 'warning' })
      }
    }

    // required_pull_request_reviews
    const reviews = live.required_pull_request_reviews
    if (desired.requirePullRequestReviews !== Boolean(reviews)) {
      diffs.push({ field: `${fullName}.required_pull_request_reviews`, expected: desired.requirePullRequestReviews, actual: Boolean(reviews), severity: 'warning' })
    } else if (desired.requirePullRequestReviews && reviews) {
      compareBool(diffs, fullName, 'dismiss_stale_reviews', desired.dismissStaleReviews, Boolean(reviews.dismiss_stale_reviews))
      compareBool(diffs, fullName, 'require_code_owner_reviews', desired.requireCodeOwnerReviews, Boolean(reviews.require_code_owner_reviews))
      compareBool(diffs, fullName, 'require_last_push_approval', desired.requireLastPushApproval, Boolean(reviews.require_last_push_approval))
      if (desired.requiredApprovingReviewCount !== (reviews.required_approving_review_count ?? 0)) {
        diffs.push({
          field: `${fullName}.required_approving_review_count`,
          expected: desired.requiredApprovingReviewCount,
          actual: reviews.required_approving_review_count ?? 0,
          severity: 'warning',
        })
      }
      compareActorSet(diffs, `${fullName}.dismissal_restrictions`, parseJsonObject(desired.dismissalRestrictionsRaw).value, reviews.dismissal_restrictions)
      compareActorSet(diffs, `${fullName}.bypass_pull_request_allowances`, parseJsonObject(desired.bypassAllowancesRaw).value, reviews.bypass_pull_request_allowances)
    }

    // restrictions
    if (desired.restrictPushes !== Boolean(live.restrictions)) {
      diffs.push({ field: `${fullName}.restrictions`, expected: desired.restrictPushes, actual: Boolean(live.restrictions), severity: 'warning' })
    } else if (desired.restrictPushes && live.restrictions) {
      compareActorSet(diffs, `${fullName}.restrictions`, parseJsonObject(desired.restrictionsRaw).value, live.restrictions)
    }

    compareBool(diffs, fullName, 'enforce_admins', desired.enforceAdmins, readEnabled(live.enforce_admins))
    compareBool(diffs, fullName, 'required_linear_history', desired.requiredLinearHistory, readEnabled(live.required_linear_history))
    compareBool(diffs, fullName, 'allow_force_pushes', desired.allowForcePushes, readEnabled(live.allow_force_pushes))
    compareBool(diffs, fullName, 'allow_deletions', desired.allowDeletions, readEnabled(live.allow_deletions))
    compareBool(diffs, fullName, 'block_creations', desired.blockCreations, readEnabled(live.block_creations))
    compareBool(diffs, fullName, 'required_conversation_resolution', desired.requiredConversationResolution, readEnabled(live.required_conversation_resolution))
    compareBool(diffs, fullName, 'lock_branch', desired.lockBranch, readEnabled(live.lock_branch))
    compareBool(diffs, fullName, 'allow_fork_syncing', desired.allowForkSyncing, readEnabled(live.allow_fork_syncing))
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compareBool(diffs: DriftDiff[], name: string, field: string, expected: boolean, actual: boolean): void {
  if (expected !== actual) diffs.push({ field: `${name}.${field}`, expected, actual, severity: 'warning' })
}

function compareActorSet(diffs: DriftDiff[], field: string, desired: Record<string, unknown> | undefined, live: LiveActorSet | undefined): void {
  const expected = normalizeActorSet(desired as LiveActorSet | undefined)
  const actual = normalizeActorSet(live)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    diffs.push({ field, expected, actual, severity: 'warning' })
  }
}
