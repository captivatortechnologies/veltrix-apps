import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate user items: a non-empty username (its identity) and display name.
 * No password field exists on this canvas by design — see the file header of
 * _shared.ts. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = item.fields ?? {}
    const username = String(f.username ?? '').trim()
    const displayName = String(f.displayName ?? '').trim()

    if (!username) {
      errors.push({ field: `items[${i}].username`, message: 'Username is required.', code: 'EMPTY_USERNAME' })
    } else if (username.length > 255) {
      errors.push({ field: `items[${i}].username`, message: `Username "${username}" exceeds 255 characters.`, code: 'NAME_TOO_LONG' })
    }

    if (!displayName) {
      errors.push({ field: `items[${i}].displayName`, message: 'Display name is required.', code: 'EMPTY_DISPLAY_NAME' })
    }

    const email = String(f.emailAddress ?? '').trim()
    if (email && !email.includes('@')) {
      warnings.push({ field: `items[${i}].emailAddress`, message: `"${email}" does not look like an email address.`, code: 'SUSPECT_EMAIL' })
    }

    if (username) {
      const key = username.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].username`,
          message: `User "${username}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_USER',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
