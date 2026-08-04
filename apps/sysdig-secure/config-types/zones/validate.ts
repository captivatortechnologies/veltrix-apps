import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isMalformedScopesJson, parseScopes, ZONE_TARGET_TYPES } from './_shared'

/**
 * Validate zone items: a non-empty unique name and at least one well-formed
 * scope with a known targetType and non-empty rules. Static — no target
 * access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one zone.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const p = (field: string) => `items[${i}].${field}`

    if (!name) {
      errors.push({ field: p('name'), message: 'Zone name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: p('name'), message: `Zone name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (isMalformedScopesJson(item.fields.scopesJson)) {
      errors.push({ field: p('scopesJson'), message: 'Scopes must be valid JSON: an array of {targetType, rules}.', code: 'INVALID_SCOPES_JSON' })
      return
    }

    const scopes = parseScopes(item.fields.scopesJson)
    if (scopes.length === 0) {
      errors.push({ field: p('scopesJson'), message: 'At least one scope is required.', code: 'EMPTY_SCOPES' })
      return
    }

    scopes.forEach((scope, si) => {
      if (!ZONE_TARGET_TYPES.has(scope.targetType)) {
        errors.push({
          field: p(`scopesJson[${si}].targetType`),
          message: `targetType must be one of ${[...ZONE_TARGET_TYPES].join(', ')} (got "${scope.targetType}").`,
          code: 'INVALID_TARGET_TYPE',
        })
      }
      if (!scope.rules) {
        errors.push({ field: p(`scopesJson[${si}].rules`), message: 'rules is required for each scope.', code: 'EMPTY_RULES' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
