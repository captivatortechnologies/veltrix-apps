import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { IMMUTABLE_DEFAULT_PROFILES, parsePermissions } from './_shared'

/**
 * Validate profile items: a non-empty name. Static — no target access required.
 * The name is the stable identity, so a duplicate name is flagged (last one
 * wins). A name matching one of TheHive's five immutable built-in profiles
 * (everything but `analyst`) is warned — TheHive will reject the write.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one profile.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Profile name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Profile name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }
    if ((IMMUTABLE_DEFAULT_PROFILES as readonly string[]).includes(name)) {
      warnings.push({
        field: `items[${i}].name`,
        message: `"${name}" is one of TheHive's immutable built-in profiles — only "analyst" can be created/edited/deleted. TheHive will likely reject this write.`,
        code: 'IMMUTABLE_PROFILE',
      })
    }

    const perms = parsePermissions(item.fields.permissions)
    if (perms.some((p) => /\s/.test(p))) {
      warnings.push({ field: `items[${i}].permissions`, message: 'One or more permission strings contain whitespace — check for a stray line break or extra spacing.', code: 'PERMISSION_WHITESPACE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
