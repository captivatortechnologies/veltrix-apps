import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseRepository, normalizeBool } from './_shared'

/**
 * Validate Dependabot items: a non-empty `owner/repo`, and the dependency GitHub
 * itself enforces surfaced early as a warning:
 *   - Dependabot security updates require Dependabot alerts.
 * Static — no target access required. The repository doubles as the identity, so
 * a duplicate is flagged (last one wins).
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
    const repository = String(item.fields.repository ?? '').trim()
    const parsed = parseRepository(repository)

    if (!repository) {
      errors.push({ field: `items[${i}].repository`, message: 'Repository is required.', code: 'EMPTY_REPOSITORY' })
    } else if (!parsed) {
      errors.push({
        field: `items[${i}].repository`,
        message: `Repository must be in "owner/repo" form (got "${repository}").`,
        code: 'INVALID_REPOSITORY',
      })
    } else {
      const key = repository.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].repository`,
          message: `Repository ${repository} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_REPOSITORY',
        })
      } else {
        seen.add(key)
      }
    }

    const alerts = normalizeBool(item.fields.vulnerability_alerts)
    const updates = normalizeBool(item.fields.security_updates)
    if (updates && !alerts) {
      warnings.push({
        field: `items[${i}].security_updates`,
        message:
          'Dependabot security updates require Dependabot alerts — enable alerts too, or GitHub may reject the update.',
        code: 'UPDATES_WITHOUT_ALERTS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
