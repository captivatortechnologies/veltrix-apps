import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseGroupPermissions } from './_shared'

/**
 * Validate permission-template items: a non-empty name (the upsert identity, so a
 * duplicate is flagged) and, when provided, a project-key pattern that is a valid regex
 * and group grants that name known permissions. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one permission template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const projectKeyPattern = String(item.fields.projectKeyPattern ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Permission template name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Permission template "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (projectKeyPattern) {
      try {
        new RegExp(projectKeyPattern)
      } catch {
        errors.push({ field: `items[${i}].projectKeyPattern`, message: `Project key pattern "${projectKeyPattern}" is not a valid regular expression.`, code: 'INVALID_PATTERN' })
      }
    }

    const { errors: grantErrors } = parseGroupPermissions(item.fields.groupPermissions)
    for (const ge of grantErrors) {
      errors.push({ field: `items[${i}].groupPermissions`, message: ge.message, code: ge.code })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
