import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, parseRepository, parseReviewers } from './_shared'

/**
 * Validate secret-scanning-options items: a non-empty `owner/repo`, well-formed
 * delegated-bypass reviewer JSON, and a warning when delegated bypass is
 * enabled with no reviewers (no one could approve a bypass). Static — no
 * target access required. The repository doubles as the identity, so a
 * duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one repository.', code: 'EMPTY' })
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
    } else {
      const key = desired.repository.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].repository`,
          message: `Repository ${desired.repository} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_REPOSITORY',
        })
      } else {
        seen.add(key)
      }
    }

    const reviewers = parseReviewers(desired.delegatedBypassReviewersRaw)
    if (reviewers.error) {
      errors.push({
        field: `items[${i}].delegated_bypass_reviewers`,
        message: `Bypass reviewers JSON is invalid — ${reviewers.error}.`,
        code: 'INVALID_REVIEWERS_JSON',
      })
    } else if (desired.delegatedBypass && reviewers.value.length === 0) {
      warnings.push({
        field: `items[${i}].delegated_bypass_reviewers`,
        message: 'Delegated push-protection bypass is enabled but no reviewers are listed — no one can approve a bypass.',
        code: 'DELEGATED_BYPASS_WITHOUT_REVIEWERS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
