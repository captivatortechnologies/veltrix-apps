import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Behavior Detection API constraints ---------------------------------

/** The four behavior-detection rule kinds Okta supports. */
export const BEHAVIOR_TYPES = ['ANOMALOUS_LOCATION', 'ANOMALOUS_IP', 'ANOMALOUS_DEVICE', 'VELOCITY'] as const
export type BehaviorType = (typeof BEHAVIOR_TYPES)[number]

/** A behavior's lifecycle state — changed via the lifecycle endpoints, not PUT. */
export const BEHAVIOR_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** A behavior name is capped at 128 characters. */
export const MAX_BEHAVIOR_NAME_LENGTH = 128

/**
 * Location granularities for an ANOMALOUS_LOCATION rule. `LatLong` additionally
 * requires a radiusKilometers in the settings blob. Compared case-insensitively
 * (Okta's own casing here is `LatLong`, unlike the upper-case CITY / COUNTRY).
 */
export const LOCATION_GRANULARITIES = ['CITY', 'COUNTRY', 'LatLong'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface BehaviorSpec {
  sectionName: string
  /** Behavior kind — one of ANOMALOUS_LOCATION | ANOMALOUS_IP | ANOMALOUS_DEVICE | VELOCITY. */
  type: string
  /** Behavior name — the logical identity deploy matches on. */
  name: string
  /** Desired lifecycle status — ACTIVE | INACTIVE. */
  status: string
  /**
   * Raw JSON string of the type-specific `settings` object:
   *   - VELOCITY            → velocityKph
   *   - ANOMALOUS_LOCATION  → granularity (+ radiusKilometers for LatLong),
   *                           maxEventsUsedForEvaluation / minEventsNeededForEvaluation
   *   - ANOMALOUS_IP        → history settings (optional)
   *   - ANOMALOUS_DEVICE    → history settings (optional)
   * Parsed to an object and sent as the behavior's `settings`.
   */
  settingsJson?: string
}

/**
 * Shape of a behavior returned by GET /behaviors. Carries an index signature so
 * a live behavior can be handed to helpers typed as `Record<string, unknown>`.
 * Behavior rules have no `system` protection flag — none are pruned.
 */
export interface LiveBehavior {
  id?: string
  name?: string
  type?: string
  status?: string
  settings?: Record<string, unknown>
  created?: string
  lastUpdated?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseSettingsObject(raw: string): Record<string, unknown> | null {
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

/** Each canvas item describes one Okta behavior-detection rule. */
export function extractBehaviorSpecs(canvas: CanvasSnapshot): BehaviorSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const settingsJson =
      typeof fields.settingsJson === 'string' && fields.settingsJson.trim()
        ? fields.settingsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      // Behavior types/statuses are upper-case enums; normalise so a lower-case
      // entry still matches instead of failing as "invalid".
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      status: typeof fields.status === 'string' ? fields.status.trim().toUpperCase() : 'ACTIVE',
      settingsJson,
    }
  })
}

// --- Per-type settings helpers -----------------------------------------------

/** True for a finite number strictly greater than zero. */
function isPositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * A per-type sanity check that the `settings` blob carries the fields the
 * behavior kind requires. Returns an error message, or null when the settings
 * are sufficient. Deliberately shallow — it enforces only the fields Okta makes
 * mandatory for each type; the history settings (max/minEvents…) are optional and
 * are left to Okta's defaults when absent.
 *
 *   - VELOCITY            → requires a positive velocityKph
 *   - ANOMALOUS_LOCATION  → requires a granularity (CITY | COUNTRY | LatLong);
 *                           LatLong additionally requires a positive radiusKilometers
 *   - ANOMALOUS_IP        → no required settings
 *   - ANOMALOUS_DEVICE    → no required settings
 */
export function checkBehaviorSettings(type: string, settings: Record<string, unknown>): string | null {
  if (type === 'VELOCITY') {
    if (!isPositiveNumber(settings.velocityKph)) {
      return 'A VELOCITY behavior needs a positive "velocityKph" in settings, e.g. {"velocityKph":805}'
    }
    return null
  }

  if (type === 'ANOMALOUS_LOCATION') {
    const granularity = settings.granularity
    const granStr = typeof granularity === 'string' ? granularity.trim() : ''
    const matched = (LOCATION_GRANULARITIES as readonly string[]).some(
      (g) => g.toLowerCase() === granStr.toLowerCase(),
    )
    if (!matched) {
      return `An ANOMALOUS_LOCATION behavior needs a "granularity" in settings, one of: ${LOCATION_GRANULARITIES.join(', ')}`
    }
    if (granStr.toLowerCase() === 'latlong' && !isPositiveNumber(settings.radiusKilometers)) {
      return 'An ANOMALOUS_LOCATION behavior with LatLong granularity needs a positive "radiusKilometers" in settings, e.g. {"granularity":"LatLong","radiusKilometers":20}'
    }
    return null
  }

  // ANOMALOUS_IP / ANOMALOUS_DEVICE — history settings are optional.
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate behavior-detection configurations against the Okta Behaviors API.
 * Static only — it never contacts Okta:
 *   - name is required, <= 128 chars, and unique within the canvas
 *   - type is one of ANOMALOUS_LOCATION | ANOMALOUS_IP | ANOMALOUS_DEVICE | VELOCITY
 *   - status (when set) is ACTIVE | INACTIVE
 *   - settingsJson (when set) parses to a JSON OBJECT, and the object carries the
 *     minimum settings the behavior's type requires (VELOCITY → velocityKph;
 *     ANOMALOUS_LOCATION → granularity, + radiusKilometers for LatLong)
 *
 * Behavior rules have no `system` protection flag, so there are no protected
 * names to reject and nothing is ever pruned.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBehaviorSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 128 chars, unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Behavior name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_BEHAVIOR_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Behavior name must be ${MAX_BEHAVIOR_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate behavior "${spec.name}" — each behavior may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — required and in the supported enum
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Behavior type is required', code: 'required' })
    } else if (!(BEHAVIOR_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Behavior type must be one of: ${BEHAVIOR_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(BEHAVIOR_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${BEHAVIOR_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // settingsJson — when present it must parse to a JSON object; then run the
    // per-type settings check. A malformed blob short-circuits the per-type check
    // to avoid a confusing double error. An absent blob still runs the per-type
    // check against {} so a VELOCITY / ANOMALOUS_LOCATION rule missing its
    // required settings is flagged.
    const settings = spec.settingsJson ? parseSettingsObject(spec.settingsJson) : {}
    if (spec.settingsJson && settings === null) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message: 'Settings must be a valid JSON object, e.g. {"velocityKph":805}',
        code: 'invalid_settings',
      })
    } else if (settings && (BEHAVIOR_TYPES as readonly string[]).includes(spec.type)) {
      const problem = checkBehaviorSettings(spec.type, settings)
      if (problem) {
        errors.push({ field: `${prefix}.settingsJson`, message: problem, code: 'missing_settings' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
