import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { specFromItem } from './_shared'

/**
 * Validate the API-security-settings singleton: a non-negative integer token
 * timeout and a recognized RBAC mode. More than one item is a warning (only
 * the first is applied — there is exactly one `/security/config` resource per
 * manager). Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Security Settings item.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  if (items.length > 1) {
    warnings.push({ field: 'items', message: 'Only the first Security Settings item is applied — this is a manager-wide singleton.', code: 'SINGLETON_EXCESS' })
  }

  const spec = specFromItem(items[0])

  if (spec.authTokenExpTimeout < 0) {
    errors.push({ field: 'items[0].auth_token_exp_timeout', message: 'Auth token expiration must be a non-negative whole number of seconds.', code: 'INVALID_TIMEOUT' })
  }

  if (spec.rbacMode !== 'white' && spec.rbacMode !== 'black') {
    errors.push({ field: 'items[0].rbac_mode', message: 'RBAC mode must be "white" or "black".', code: 'INVALID_RBAC_MODE' })
  } else if (spec.rbacMode === 'black') {
    warnings.push({ field: 'items[0].rbac_mode', message: 'Black mode is default-allow — actions are only blocked if an explicit deny policy matches. Verify this is intentional.', code: 'BLACK_MODE' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
