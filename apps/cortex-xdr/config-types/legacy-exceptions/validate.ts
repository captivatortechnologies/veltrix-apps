import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  LEGACY_EXCEPTION_PLATFORMS,
  LEGACY_EXCEPTION_STATUSES,
  LEGACY_EXCEPTION_SCOPES,
  isValidConditionsJson,
} from './_shared'

/**
 * Validate legacy-exception items: a non-empty name, a positive module id, a
 * known platform + status + scope, at least one profile id when scope is
 * "profile", and valid JSON for the required conditions object. Static — no
 * target access required. The name doubles as the exception's identity, so a
 * duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one legacy exception.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const platform = String(item.fields.platform ?? '').trim().toLowerCase()
    const module = Number(item.fields.module ?? 0)
    const status = String(item.fields.status ?? '').trim().toLowerCase() || 'enabled'
    const scope = String(item.fields.scope ?? '').trim().toLowerCase() || 'global'
    const profileIds = Array.isArray(item.fields.profile_ids) ? (item.fields.profile_ids as unknown[]) : []

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Exception "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!LEGACY_EXCEPTION_PLATFORMS.has(platform)) {
      errors.push({ field: `items[${i}].platform`, message: `Platform must be one of ${[...LEGACY_EXCEPTION_PLATFORMS].join(', ')} (got "${platform}").`, code: 'INVALID_PLATFORM' })
    }

    if (!Number.isInteger(module) || module <= 0) {
      errors.push({ field: `items[${i}].module`, message: 'Module must be a positive module id — look it up via the console or /legacy_exceptions/get_modules/.', code: 'INVALID_MODULE' })
    }

    if (!LEGACY_EXCEPTION_STATUSES.has(status)) {
      errors.push({ field: `items[${i}].status`, message: `Status must be one of ${[...LEGACY_EXCEPTION_STATUSES].join(', ')} (got "${status}").`, code: 'INVALID_STATUS' })
    }

    if (!LEGACY_EXCEPTION_SCOPES.has(scope)) {
      errors.push({ field: `items[${i}].scope`, message: `Scope must be one of ${[...LEGACY_EXCEPTION_SCOPES].join(', ')} (got "${scope}").`, code: 'INVALID_SCOPE' })
    } else if (scope === 'profile' && profileIds.length === 0) {
      errors.push({ field: `items[${i}].profile_ids`, message: 'At least one profile id is required when scope is "profile".', code: 'MISSING_PROFILE_IDS' })
    }

    if (!isValidConditionsJson(item.fields.conditions)) {
      errors.push({ field: `items[${i}].conditions`, message: 'Conditions is required and must be a valid JSON object.', code: 'INVALID_CONDITIONS_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
