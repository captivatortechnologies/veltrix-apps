import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Rate Limit Settings API constraints --------------------------------
//
// Rate-limit settings are three org SINGLETONS updated as full replaces:
//   GET/PUT /api/v1/rate-limit-settings/admin-notifications  { notificationsEnabled }
//   GET/PUT /api/v1/rate-limit-settings/per-client           { defaultMode, useCaseModeOverrides }
//   GET/PUT /api/v1/rate-limit-settings/warning-threshold    { warningThreshold }
// There is no create/delete and no lifecycle.

/** Per-client rate-limit modes Okta supports (upper-case enum). */
export const PER_CLIENT_MODES = ['DISABLE', 'ENFORCE', 'PREVIEW'] as const

/** Sentinel meaning "no override — inherit the default mode". */
export const INHERIT = 'INHERIT'

/** Per-client override modes accepted on a use-case field (INHERIT drops the override). */
export const PER_CLIENT_OVERRIDE_MODES = [INHERIT, ...PER_CLIENT_MODES] as const

/** The warning-threshold percentage is bounded 30..90 by Okta. */
export const MIN_WARNING_THRESHOLD = 30
export const MAX_WARNING_THRESHOLD = 90

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RateLimitSpec {
  sectionName: string
  /** notificationsEnabled — whether super admins are emailed on rate-limit hits. */
  adminNotificationsEnabled: boolean
  /** Per-client default mode — DISABLE | ENFORCE | PREVIEW. */
  perClientDefaultMode: string
  /** Per-use-case overrides; a value of INHERIT means "omit — use the default". */
  perClientLoginPageMode: string
  perClientOAuth2AuthorizeMode: string
  perClientOIEAppIntentMode: string
  /** Warning-threshold percentage (30..90), or undefined when left blank. */
  warningThresholdPercent?: number
}

/** Shape of GET /rate-limit-settings/admin-notifications. */
export interface LiveAdminNotifications {
  notificationsEnabled?: boolean
  [key: string]: unknown
}

/** Shape of GET /rate-limit-settings/per-client. */
export interface LivePerClient {
  defaultMode?: string
  useCaseModeOverrides?: {
    LOGIN_PAGE?: string
    OAUTH2_AUTHORIZE?: string
    OIE_APP_INTENT?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** Shape of GET /rate-limit-settings/warning-threshold. */
export interface LiveWarningThreshold {
  warningThreshold?: number
  [key: string]: unknown
}

/** Coerce a canvas checkbox value (boolean, or "true"/"false" string) to a boolean. */
export function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

/** Coerce a canvas number value (number or numeric string) to a finite number, or undefined. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function normMode(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : fallback
}

/**
 * Extract the rate-limit spec(s). It is a singleton, so a well-formed canvas has
 * exactly one item; all are returned so validate can flag a canvas that declares
 * more than one.
 */
export function extractRateLimitSpecs(canvas: CanvasSnapshot): RateLimitSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      adminNotificationsEnabled: toBoolean(fields.adminNotificationsEnabled, true),
      perClientDefaultMode: normMode(fields.perClientDefaultMode, 'ENFORCE'),
      perClientLoginPageMode: normMode(fields.perClientLoginPageMode, INHERIT),
      perClientOAuth2AuthorizeMode: normMode(fields.perClientOAuth2AuthorizeMode, INHERIT),
      perClientOIEAppIntentMode: normMode(fields.perClientOIEAppIntentMode, INHERIT),
      warningThresholdPercent: toNumber(fields.warningThresholdPercent),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the rate-limit configuration against the Okta Rate Limit Settings API.
 * Static only — it never contacts Okta:
 *   - exactly one configuration may be declared (it is an org singleton)
 *   - per-client default mode is one of DISABLE | ENFORCE | PREVIEW
 *   - each per-use-case override is INHERIT or one of the modes
 *   - the warning threshold (when set) is an integer between 30 and 90
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRateLimitSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'sections',
      message: 'Rate-limit settings are an org singleton — declare exactly one configuration',
      code: 'singleton',
    })
  }

  for (const spec of specs) {
    const prefix = spec.sectionName

    // per-client default mode — required, in the enum
    if (!(PER_CLIENT_MODES as readonly string[]).includes(spec.perClientDefaultMode)) {
      errors.push({
        field: `${prefix}.perClientDefaultMode`,
        message: `Default mode must be one of: ${PER_CLIENT_MODES.join(', ')}`,
        code: 'invalid_mode',
      })
    }

    // per-use-case overrides — INHERIT or one of the modes
    const overrides: Array<[string, string]> = [
      ['perClientLoginPageMode', spec.perClientLoginPageMode],
      ['perClientOAuth2AuthorizeMode', spec.perClientOAuth2AuthorizeMode],
      ['perClientOIEAppIntentMode', spec.perClientOIEAppIntentMode],
    ]
    for (const [field, value] of overrides) {
      if (!(PER_CLIENT_OVERRIDE_MODES as readonly string[]).includes(value)) {
        errors.push({
          field: `${prefix}.${field}`,
          message: `Override must be one of: ${PER_CLIENT_OVERRIDE_MODES.join(', ')}`,
          code: 'invalid_mode',
        })
      }
    }

    // warning threshold — when set, an integer 30..90
    if (spec.warningThresholdPercent !== undefined) {
      const t = spec.warningThresholdPercent
      if (!Number.isInteger(t) || t < MIN_WARNING_THRESHOLD || t > MAX_WARNING_THRESHOLD) {
        errors.push({
          field: `${prefix}.warningThresholdPercent`,
          message: `Warning threshold must be an integer between ${MIN_WARNING_THRESHOLD} and ${MAX_WARNING_THRESHOLD}`,
          code: 'invalid_threshold',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
