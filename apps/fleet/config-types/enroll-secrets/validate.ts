import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate enroll-secret items: a safe label, a non-empty secret value, and a
 * numeric (or blank) team id. Static — no target access required.
 */
const LABEL_RE = /^[A-Za-z0-9 ._:-]+$/
const TEAM_ID_RE = /^[0-9]*$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one enroll secret.', code: 'EMPTY' })
  }

  const seenLabels = new Set<string>()
  const seenValuesByScope = new Map<string, Set<string>>()
  items.forEach((item, i) => {
    const label = String(item.fields.label ?? '').trim()
    const teamId = String(item.fields.teamId ?? '').trim()
    const value = String(item.fields.value ?? '')

    if (!label) {
      errors.push({ field: `items[${i}].label`, message: 'Label is required.', code: 'EMPTY_LABEL' })
    } else if (!LABEL_RE.test(label)) {
      errors.push({ field: `items[${i}].label`, message: `Label "${label}" may only contain letters, numbers, space, dot, underscore, colon or hyphen.`, code: 'INVALID_LABEL' })
    } else if (seenLabels.has(label)) {
      warnings.push({ field: `items[${i}].label`, message: `Label ${label} is listed more than once.`, code: 'DUPLICATE_LABEL' })
    } else {
      seenLabels.add(label)
    }

    if (!TEAM_ID_RE.test(teamId)) {
      errors.push({ field: `items[${i}].teamId`, message: 'Team ID must be numeric, or blank for the global secret.', code: 'INVALID_TEAM_ID' })
    }

    if (!value) {
      errors.push({ field: `items[${i}].value`, message: 'Secret Value is required.', code: 'EMPTY_VALUE' })
    } else {
      const scopeKey = teamId || 'global'
      const seenValues = seenValuesByScope.get(scopeKey) ?? new Set<string>()
      if (seenValues.has(value)) {
        warnings.push({ field: `items[${i}].value`, message: 'This secret value is declared more than once in the same scope.', code: 'DUPLICATE_VALUE' })
      }
      seenValues.add(value)
      seenValuesByScope.set(scopeKey, seenValues)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
