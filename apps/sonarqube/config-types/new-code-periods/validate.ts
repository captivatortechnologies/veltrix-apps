import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NEW_CODE_TYPES, levelLabel } from './_shared'

/**
 * Validate new-code-period items: `type` must be a known SonarQube new-code type, and
 * project/branch/value must be consistent with that type's level restrictions and value
 * shape (see _shared.ts header). Static — no target access required. The (project,
 * branch) pair is the level identity, so a level declared twice is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one new code period.', code: 'EMPTY' })
  }

  const seenLevels = new Set<string>()

  items.forEach((item, i) => {
    const project = String(item.fields.project ?? '').trim()
    const branch = String(item.fields.branch ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const value = String(item.fields.value ?? '').trim()

    const levelKey = `${project.toLowerCase()}::${branch.toLowerCase()}`
    if (seenLevels.has(levelKey)) {
      warnings.push({ field: `items[${i}]`, message: `New code period for ${levelLabel(project, branch)} is declared more than once; the last one wins.`, code: 'DUPLICATE_LEVEL' })
    } else {
      seenLevels.add(levelKey)
    }

    if (!type || !NEW_CODE_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: 'Type must be one of Previous version, Number of days, Reference branch, Specific analysis.', code: 'INVALID_TYPE' })
    }

    if (branch && !project) {
      errors.push({ field: `items[${i}].branch`, message: 'A branch-level definition requires a project key.', code: 'BRANCH_REQUIRES_PROJECT' })
    }

    if (type === 'REFERENCE_BRANCH' && !project) {
      errors.push({ field: `items[${i}].type`, message: 'Reference branch cannot be set at the global level; set a project (and optionally a branch).', code: 'GLOBAL_NOT_ALLOWED' })
    }

    if (type === 'SPECIFIC_ANALYSIS' && (!project || !branch)) {
      errors.push({ field: `items[${i}].type`, message: 'Specific analysis can only be set at the branch level; set both project and branch.', code: 'BRANCH_ONLY_TYPE' })
    }

    if (type === 'NUMBER_OF_DAYS') {
      const days = Number(value)
      if (!value || !Number.isInteger(days) || days < 1 || days > 90) {
        errors.push({ field: `items[${i}].value`, message: 'Number of days must be a whole number between 1 and 90.', code: 'INVALID_DAYS' })
      }
    }

    if (type === 'PREVIOUS_VERSION' && value) {
      warnings.push({ field: `items[${i}].value`, message: 'Previous version takes no value; it will be ignored.', code: 'IGNORED_VALUE' })
    }

    if (type === 'REFERENCE_BRANCH' && !value) {
      errors.push({ field: `items[${i}].value`, message: 'A reference branch name is required.', code: 'EMPTY_VALUE' })
    }

    if (type === 'SPECIFIC_ANALYSIS') {
      if (!value) {
        errors.push({ field: `items[${i}].value`, message: 'An analysis id is required.', code: 'EMPTY_VALUE' })
      }
      warnings.push({
        field: `items[${i}].value`,
        message: 'Analysis ids are ephemeral — SonarQube purges old analyses over time, which can silently invalidate this declaration.',
        code: 'EPHEMERAL_ANALYSIS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
