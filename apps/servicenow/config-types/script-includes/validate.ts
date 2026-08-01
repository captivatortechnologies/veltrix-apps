import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr } from '../../lib/tableRecords'
import { ACCESS_VALUES, NAME_RE } from './_shared'

/**
 * Validate script-include items. Static — no target access required:
 *   - a non-empty name that is a valid identifier (it names a class/function)
 *   - a non-empty script
 *   - a valid access value (package_private | public)
 * Identity is `name`; a duplicate name is flagged (last one wins). A public,
 * client-callable script include widens the attack surface (warning).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one script include.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)
    const script = trimStr(item.fields.script)
    const access = trimStr(item.fields.access) || 'package_private'

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Name "${name}" must be a valid identifier (letters, digits and underscores; starting with a letter) — it names the class or function.`,
        code: 'INVALID_NAME',
      })
    }

    if (!script) {
      errors.push({ field: `items[${i}].script`, message: 'Script is required for a script include.', code: 'EMPTY_SCRIPT' })
    }

    if (!ACCESS_VALUES.has(access)) {
      errors.push({
        field: `items[${i}].access`,
        message: `Accessible from must be package_private or public (got "${access}").`,
        code: 'INVALID_ACCESS',
      })
    }

    const clientCallable = String(item.fields.clientCallable ?? '').trim().toLowerCase()
    if ((clientCallable === 'true' || clientCallable === '1') && access === 'public') {
      warnings.push({
        field: `items[${i}].access`,
        message: `Script include "${name || '(unnamed)'}" is public AND client-callable — confirm it must be reachable from other scopes and the client.`,
        code: 'PUBLIC_CLIENT_CALLABLE',
      })
    }

    if (name) {
      if (seen.has(name)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Script include "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(name)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
