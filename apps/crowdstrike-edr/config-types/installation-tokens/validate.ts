import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Installation Tokens API constraints -------------------------------------

/**
 * Only fully-formed RFC3339 timestamps pass validation — anything looser would
 * be parsed in the server's local timezone and sent ambiguously to the API. A
 * trailing Z (UTC) or a numeric offset (+/-HH:MM) is required.
 */
export const EXPIRES_RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface InstallationTokenSpec {
  sectionName: string
  label: string
  /** RFC3339 timestamp, or '' for a token that never expires. */
  expiresTimestamp: string
  revoked: boolean
}

/** Each canvas section describes one installation token. */
export function extractInstallationTokenSpecs(canvas: CanvasSnapshot): InstallationTokenSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawExpires = typeof fields.expiresTimestamp === 'string' ? fields.expiresTimestamp.trim() : ''
    return {
      sectionName: section.name,
      label: typeof fields.label === 'string' ? fields.label.trim() : '',
      expiresTimestamp: rawExpires ? normalizeExpiresTimestamp(rawExpires) : '',
      revoked: coerceBoolean(fields.revoked, false),
    }
  })
}

/** Accept date-only or minute/second precision input; the API wants full RFC3339. */
export function normalizeExpiresTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) {
    return value.length === 16 ? `${value}:00Z` : `${value}Z`
  }
  return value
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate installation token configurations against Installation Tokens API
 * constraints: a unique label and, when set, an RFC3339 expiry timestamp.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractInstallationTokenSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // label (identity)
    if (!spec.label) {
      errors.push({ field: `${prefix}.label`, message: 'Token label is required', code: 'required' })
    } else if (seen.has(spec.label)) {
      errors.push({
        field: `${prefix}.label`,
        message: `Duplicate token label "${spec.label}" — each label may only be declared once per canvas`,
        code: 'duplicate_token',
      })
    }
    seen.add(spec.label)

    // expiry
    if (spec.expiresTimestamp) {
      if (!EXPIRES_RFC3339_RE.test(spec.expiresTimestamp) || Number.isNaN(Date.parse(spec.expiresTimestamp))) {
        errors.push({
          field: `${prefix}.expiresTimestamp`,
          message: 'Expiry must be an RFC3339 timestamp, e.g. 2026-12-31T00:00:00Z (leave empty for no expiry)',
          code: 'invalid_format',
        })
      } else if (Date.parse(spec.expiresTimestamp) <= Date.now()) {
        warnings.push({
          field: `${prefix}.expiresTimestamp`,
          message: 'Expiry is in the past — the token will be expired and unusable as soon as it is deployed',
          code: 'expired',
        })
      }
    }

    // revoke state
    if (spec.revoked) {
      warnings.push({
        field: `${prefix}.revoked`,
        message: 'Token will be deployed in a revoked state and cannot install sensors until it is restored',
        code: 'revoked_on_deploy',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
