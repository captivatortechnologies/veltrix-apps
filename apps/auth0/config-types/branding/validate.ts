import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { UNIVERSAL_LOGIN_EXPERIENCES } from './_shared'

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

/**
 * Validate the Auth0 branding singleton: at most one item, well-formed hex
 * colors, and a known universal_login_experience value. Static — no target
 * access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Branding is a singleton — declare it only once per canvas.', code: 'SINGLETON' })
  }

  const item = items[0]
  if (item) {
    for (const key of ['colors_primary', 'colors_page_background'] as const) {
      const value = readString(item.fields[key])
      if (value && !HEX_COLOR_RE.test(value)) {
        errors.push({ field: `items[0].${key}`, message: `"${value}" must be a 6-digit hex color, e.g. #635DFF.`, code: 'INVALID_COLOR' })
      }
    }

    const experience = readString(item.fields.universal_login_experience)
    if (experience && !UNIVERSAL_LOGIN_EXPERIENCES.has(experience)) {
      errors.push({
        field: 'items[0].universal_login_experience',
        message: `Universal Login experience must be "new" or "classic" (got "${experience}").`,
        code: 'INVALID_EXPERIENCE',
      })
    }

    if (item.fields.webauthn_platform_first_factor === true && experience === 'classic') {
      warnings.push({
        field: 'items[0].webauthn_platform_first_factor',
        message: 'WebAuthn Platform First Factor only applies to the New Universal Login experience.',
        code: 'WEBAUTHN_REQUIRES_NEW_EXPERIENCE',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
