import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, parseRepository, parseJsonObject } from './_shared'

/**
 * Validate branch-protection-classic items: a non-empty `owner/repo` + branch,
 * well-formed JSON for the three actor-set fields, and a sane approving-review
 * count. Static — no target access required. (repository, branch) is the
 * identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one branch.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)

    if (!desired.repository) {
      errors.push({ field: `items[${i}].repository`, message: 'Repository is required.', code: 'EMPTY_REPOSITORY' })
    } else if (!parsed) {
      errors.push({
        field: `items[${i}].repository`,
        message: `Repository must be in "owner/repo" form (got "${desired.repository}").`,
        code: 'INVALID_REPOSITORY',
      })
    }
    if (!desired.branch) {
      errors.push({ field: `items[${i}].branch`, message: 'Branch is required.', code: 'EMPTY_BRANCH' })
    }

    if (parsed && desired.branch) {
      const key = `${desired.repository.toLowerCase()}@${desired.branch}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].branch`,
          message: `Branch ${desired.branch} on ${desired.repository} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_BRANCH',
        })
      } else {
        seen.add(key)
      }
    }

    const dismissal = parseJsonObject(desired.dismissalRestrictionsRaw)
    if (dismissal.error) errors.push({ field: `items[${i}].dismissal_restrictions`, message: `Dismissal restrictions JSON is invalid — ${dismissal.error}.`, code: 'INVALID_DISMISSAL_JSON' })

    const bypass = parseJsonObject(desired.bypassAllowancesRaw)
    if (bypass.error) errors.push({ field: `items[${i}].bypass_pull_request_allowances`, message: `Bypass allowances JSON is invalid — ${bypass.error}.`, code: 'INVALID_BYPASS_JSON' })

    const restrictions = parseJsonObject(desired.restrictionsRaw)
    if (restrictions.error) errors.push({ field: `items[${i}].restrictions`, message: `Restrictions JSON is invalid — ${restrictions.error}.`, code: 'INVALID_RESTRICTIONS_JSON' })

    if (desired.requirePullRequestReviews && desired.requiredApprovingReviewCount === 0) {
      warnings.push({
        field: `items[${i}].required_approving_review_count`,
        message: 'Pull requests are required but 0 approvals are required — anyone can merge without review.',
        code: 'ZERO_REQUIRED_APPROVALS',
      })
    }
    if (desired.restrictPushes && Object.keys(restrictions.value).length === 0) {
      warnings.push({
        field: `items[${i}].restrictions`,
        message: 'Push restrictions are enabled but no users/teams/apps are listed — no one (not even admins without bypass) will be able to push.',
        code: 'RESTRICT_PUSHES_WITHOUT_ACTORS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
