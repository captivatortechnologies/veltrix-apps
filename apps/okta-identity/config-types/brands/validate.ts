import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Brands API constraints ---------------------------------------------
//
// A brand's identity in Okta is its NAME; deploy lists brands, matches on the
// name, and PUTs (update) or POSTs (create). Okta supports ONE theme per brand,
// reconciled as a sub-resource. The default brand (isDefault:true) is updated in
// place but never created or deleted. Logos/favicon/background are binary uploads
// via separate endpoints — OUT OF SCOPE here.

/** A 6-digit hex colour, e.g. #1662dd. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** The theme colour field keys, mapped to their Okta theme property names. */
export const THEME_COLOR_FIELDS: Array<[keyof ThemeColors, string]> = [
  ['primaryColorHex', 'primaryColorHex'],
  ['primaryColorContrastHex', 'primaryColorContrastHex'],
  ['secondaryColorHex', 'secondaryColorHex'],
  ['secondaryColorContrastHex', 'secondaryColorContrastHex'],
]

export interface ThemeColors {
  primaryColorHex?: string
  primaryColorContrastHex?: string
  secondaryColorHex?: string
  secondaryColorContrastHex?: string
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface BrandSpec extends ThemeColors {
  sectionName: string
  /** Brand name — the logical identity deploy matches on. */
  name: string
  removePoweredByOkta: boolean
  customPrivacyPolicyUrl?: string
  agreeToCustomPrivacyPolicy: boolean
  locale?: string
  emailDomainId?: string
  /** Raw JSON string of touchpoint-variant theme fields, merged into the theme PUT. */
  themeConfigJson?: string
}

/** Shape of a brand returned by GET /brands. */
export interface LiveBrand {
  id?: string
  name?: string
  isDefault?: boolean
  removePoweredByOkta?: boolean
  customPrivacyPolicyUrl?: string | null
  agreeToCustomPrivacyPolicy?: boolean
  locale?: string
  emailDomainId?: string | null
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/** Shape of a theme returned by GET /brands/{id}/themes. */
export interface LiveTheme {
  id?: string
  primaryColorHex?: string
  primaryColorContrastHex?: string
  secondaryColorHex?: string
  secondaryColorContrastHex?: string
  logo?: string
  favicon?: string
  backgroundImage?: string
  _links?: unknown
  [key: string]: unknown
}

/** Coerce a canvas checkbox value (boolean or "true"/"false") to a boolean. */
export function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Parse a raw JSON string, returning the OBJECT or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too).
 */
export function parseConfigObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/** Each canvas item describes one Okta brand plus its theme. */
export function extractBrandSpecs(canvas: CanvasSnapshot): BrandSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      removePoweredByOkta: toBoolean(fields.removePoweredByOkta, false),
      customPrivacyPolicyUrl: trimmed(fields.customPrivacyPolicyUrl),
      agreeToCustomPrivacyPolicy: toBoolean(fields.agreeToCustomPrivacyPolicy, false),
      locale: trimmed(fields.locale),
      emailDomainId: trimmed(fields.emailDomainId),
      primaryColorHex: trimmed(fields.primaryColorHex),
      primaryColorContrastHex: trimmed(fields.primaryColorContrastHex),
      secondaryColorHex: trimmed(fields.secondaryColorHex),
      secondaryColorContrastHex: trimmed(fields.secondaryColorContrastHex),
      themeConfigJson: trimmed(fields.themeConfigJson),
    }
  })
}

/** True when the spec declares any theme change (a colour or the variants blob). */
export function hasThemeChange(spec: BrandSpec): boolean {
  return (
    spec.primaryColorHex !== undefined ||
    spec.primaryColorContrastHex !== undefined ||
    spec.secondaryColorHex !== undefined ||
    spec.secondaryColorContrastHex !== undefined ||
    spec.themeConfigJson !== undefined
  )
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate brand configurations against the Okta Brands API. Static only — it
 * never contacts Okta:
 *   - name is required and unique within the canvas
 *   - each theme colour (when set) is a 6-digit hex code
 *   - a custom privacy-policy URL (when set) is https and requires consent
 *   - themeConfigJson (when set) parses to a JSON object
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBrandSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Brand name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate brand "${spec.name}" — each brand may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // theme colours — 6-digit hex when set
    for (const [fieldKey] of THEME_COLOR_FIELDS) {
      const value = spec[fieldKey]
      if (value !== undefined && !HEX_COLOR_PATTERN.test(value)) {
        errors.push({
          field: `${prefix}.${fieldKey}`,
          message: `${fieldKey} must be a 6-digit hex colour, e.g. #1662dd`,
          code: 'invalid_color',
        })
      }
    }

    // custom privacy-policy URL — https, and consent required
    if (spec.customPrivacyPolicyUrl) {
      if (!/^https:\/\//i.test(spec.customPrivacyPolicyUrl)) {
        errors.push({
          field: `${prefix}.customPrivacyPolicyUrl`,
          message: 'Custom privacy policy URL must be an https URL',
          code: 'invalid_url',
        })
      }
      if (!spec.agreeToCustomPrivacyPolicy) {
        warnings.push({
          field: `${prefix}.agreeToCustomPrivacyPolicy`,
          message:
            'Okta requires "Agree to custom privacy policy" to be checked when a custom privacy policy URL is set — the update may be rejected',
          code: 'consent_required',
        })
      }
    }

    // themeConfigJson — a JSON object when set
    if (spec.themeConfigJson && parseConfigObject(spec.themeConfigJson) === null) {
      errors.push({
        field: `${prefix}.themeConfigJson`,
        message:
          'Theme variants must be a JSON object, e.g. {"signInPageTouchPointVariant":"OKTA_DEFAULT"}',
        code: 'invalid_theme_config',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
