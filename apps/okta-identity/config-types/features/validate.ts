import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta self-service Feature API constraints -------------------------------
//
// Self-service features are UPDATE-ONLY toggles — there is no create and no
// delete. A feature is enabled/disabled through its lifecycle endpoint:
//   GET  /features                         — list all self-service features
//   GET  /features/{featureId}             — retrieve one
//   POST /features/{featureId}/{lifecycle} — ENABLE | DISABLE (mode=force optional)
// A feature's identity is its NAME; deploy lists features and matches on the
// name (case-insensitive). `status` is an UPPER-CASE enum (ENABLED | DISABLED).

/** The two lifecycle states a self-service feature can be in (upper-case enum). */
export const FEATURE_STATUSES = ['ENABLED', 'DISABLED'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface FeatureSpec {
  sectionName: string
  /** The feature's display name — the logical identity deploy matches on. */
  name: string
  /** Desired lifecycle state — ENABLED | DISABLED (upper-case). */
  status: string
  /**
   * When true, deploy sends `?mode=force` so Okta also enables required
   * dependencies (on ENABLE) or disables dependents (on DISABLE).
   */
  forceDependencies: boolean
}

/** Shape of a Feature returned by GET /features. */
export interface LiveFeature {
  id?: string
  name?: string
  description?: string
  /** Always "self-service" for the features this type manages. */
  type?: string
  /** ENABLED | DISABLED. */
  status?: string
  /** Release stage, e.g. { state: "OPEN"|"CLOSED", value: "BETA"|"EA" }. */
  stage?: { state?: string; value?: string; [key: string]: unknown }
  _links?: unknown
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

/**
 * Extract one FeatureSpec per canvas item. `name` is trimmed; `status` is
 * upper-cased (blank when unset so validate can flag it as required); the
 * force-dependencies flag defaults to false.
 */
export function extractFeatureSpecs(canvas: CanvasSnapshot): FeatureSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // status is an upper-case enum; normalise so a lower-case entry still matches.
      status:
        typeof fields.status === 'string' && fields.status.trim()
          ? fields.status.trim().toUpperCase()
          : '',
      forceDependencies: toBoolean(fields.forceDependencies, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate self-service feature toggles against the Okta Features API. Static
 * only — it never contacts Okta:
 *   - name is required and unique within the canvas (case-insensitive)
 *   - status is required and one of ENABLED | DISABLED
 *
 * There is no shape to check on the definition — a feature is only ever toggled,
 * and whether the named feature actually exists is confirmed at deploy time
 * (features cannot be created through the API).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFeatureSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required and unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Feature name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate feature "${spec.name}" — each feature may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // status — required and in the enum
    if (!spec.status) {
      errors.push({ field: `${prefix}.status`, message: 'Desired state (status) is required', code: 'required' })
    } else if (!(FEATURE_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${FEATURE_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
