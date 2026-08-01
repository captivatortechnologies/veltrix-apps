import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractProjectSpecs, normalizeName } from './_shared'

/**
 * Validate project-settings items: a non-empty project name, sane primary-branch
 * and tag values, and a unique project name per canvas. Static — no target access
 * required. The project name doubles as identity, so a duplicate is an error
 * (two items would fight over the same project).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractProjectSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one project.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    if (!spec.projectName) {
      errors.push({ field: `items[${i}].projectName`, message: 'Project name is required.', code: 'EMPTY_PROJECT_NAME' })
    } else {
      const key = normalizeName(spec.projectName)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].projectName`,
          message: `Project "${spec.projectName}" is declared more than once — each project may only appear once.`,
          code: 'DUPLICATE_PROJECT',
        })
      } else {
        seen.add(key)
      }
    }

    if (spec.primaryBranch && /\s/.test(spec.primaryBranch)) {
      errors.push({
        field: `items[${i}].primaryBranch`,
        message: `Primary branch "${spec.primaryBranch}" must not contain whitespace (use a full ref such as refs/heads/main).`,
        code: 'INVALID_PRIMARY_BRANCH',
      })
    }

    if (spec.manageTags) {
      for (const tag of spec.tags) {
        if (tag.includes(',')) {
          errors.push({
            field: `items[${i}].tags`,
            message: `Tag "${tag}" must not contain a comma.`,
            code: 'INVALID_TAG',
          })
        }
      }
    } else if (spec.tags.length > 0) {
      warnings.push({
        field: `items[${i}].tags`,
        message: `Tags are listed for "${spec.projectName || `item ${i}`}" but "Manage tags declaratively" is off — the tags will be ignored.`,
        code: 'TAGS_UNMANAGED',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
