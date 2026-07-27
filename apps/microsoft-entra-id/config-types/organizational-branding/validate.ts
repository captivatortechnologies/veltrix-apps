import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra organizational-branding (default) constraints ---------------------
//
// Scalar-bounded: only the text / color / URL sign-in page properties are
// managed. Stream properties (logos, background image, favicon, custom CSS) and
// the layout / visibility sub-objects are out of scope. Managed as a per-tenant
// default-branding singleton (locale "0").

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export const BRANDING_COLOR_FIELDS = ['backgroundColor', 'headerBackgroundColor'] as const
export const BRANDING_URL_FIELDS = [
  'customPrivacyAndCookiesUrl',
  'customTermsOfUseUrl',
  'customAccountResetCredentialsUrl',
] as const
/** field -> max length */
export const BRANDING_TEXT_FIELDS: Record<string, number> = {
  signInPageText: 1024,
  usernameHintText: 64,
  customForgotMyPasswordText: 256,
  customCannotAccessYourAccountText: 256,
  customPrivacyAndCookiesText: 256,
  customTermsOfUseText: 256,
}
const URL_MAX_LENGTH = 128

/** Every managed field key, in a stable order. */
export const BRANDING_FIELDS: string[] = [
  ...BRANDING_COLOR_FIELDS,
  ...Object.keys(BRANDING_TEXT_FIELDS),
  ...BRANDING_URL_FIELDS,
]

export interface BrandingSpec {
  itemId?: string
  /** Managed field key -> value ('' means "do not manage this field"). */
  values: Record<string, string>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractBrandingSpecs(canvas: CanvasSnapshot): BrandingSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const values: Record<string, string> = {}
    for (const key of BRANDING_FIELDS) values[key] = asString(f[key])
    return { itemId: item.id, values }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractBrandingSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'items',
      message: 'Organizational branding (default) is a singleton — declare it only once per canvas',
      code: 'singleton',
    })
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    const v = spec.values

    for (const color of BRANDING_COLOR_FIELDS) {
      if (v[color] && !HEX_COLOR_RE.test(v[color])) {
        errors.push({ field: `${prefix}.${color}`, message: `${color} must be a #RGB or #RRGGBB hex color`, code: 'invalid_color' })
      }
    }
    for (const [field, max] of Object.entries(BRANDING_TEXT_FIELDS)) {
      if (v[field] && v[field].length > max) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} must be ${max} characters or fewer`, code: 'too_long' })
      }
    }
    for (const url of BRANDING_URL_FIELDS) {
      if (v[url] && v[url].length > URL_MAX_LENGTH) {
        errors.push({ field: `${prefix}.${url}`, message: `${url} must be ${URL_MAX_LENGTH} characters or fewer`, code: 'too_long' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
