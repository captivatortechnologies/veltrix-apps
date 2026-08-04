import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  desiredFromItem,
  parseRepository,
  CODE_SCANNING_STATES,
  QUERY_SUITES,
  THREAT_MODELS,
  CODE_SCANNING_LANGUAGES,
} from './_shared'

/**
 * Validate code-scanning-default-setup items: a non-empty `owner/repo`, valid
 * enums, a runner label when a labeled runner is selected, and known
 * languages. Static — no target access required. The repository doubles as
 * the identity, so a duplicate is flagged (last one wins).
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

    if (!CODE_SCANNING_STATES.includes(desired.state as (typeof CODE_SCANNING_STATES)[number])) {
      errors.push({ field: `items[${i}].state`, message: `State must be one of ${CODE_SCANNING_STATES.join(', ')}.`, code: 'INVALID_STATE' })
    }
    if (!QUERY_SUITES.includes(desired.querySuite as (typeof QUERY_SUITES)[number])) {
      errors.push({ field: `items[${i}].query_suite`, message: `Query suite must be one of ${QUERY_SUITES.join(', ')}.`, code: 'INVALID_QUERY_SUITE' })
    }
    if (!THREAT_MODELS.includes(desired.threatModel as (typeof THREAT_MODELS)[number])) {
      errors.push({ field: `items[${i}].threat_model`, message: `Threat model must be one of ${THREAT_MODELS.join(', ')}.`, code: 'INVALID_THREAT_MODEL' })
    }

    for (const lang of desired.languages) {
      if (!CODE_SCANNING_LANGUAGES.includes(lang as (typeof CODE_SCANNING_LANGUAGES)[number])) {
        warnings.push({
          field: `items[${i}].languages`,
          message: `"${lang}" is not a recognized default-setup language — GitHub may reject it.`,
          code: 'UNKNOWN_LANGUAGE',
        })
      }
    }

    if (desired.runnerType === 'labeled' && !desired.runnerLabel) {
      errors.push({
        field: `items[${i}].runner_label`,
        message: 'Runner label is required when runner type is "Self-hosted (labeled)".',
        code: 'MISSING_RUNNER_LABEL',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
