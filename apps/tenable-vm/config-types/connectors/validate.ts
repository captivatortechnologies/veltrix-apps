import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Connectors API constraints --------------------------------------

/** A connector syncs assets from exactly one of these cloud providers. */
export const CONNECTOR_TYPES = ['aws', 'azure', 'gcp'] as const
export type ConnectorType = (typeof CONNECTOR_TYPES)[number]

/** schedule.units is an enum on the Tenable Connectors API. */
export const SCHEDULE_UNITS = ['hours', 'days'] as const

export const MAX_CONNECTOR_NAME_LENGTH = 255

/** A network reference is a standard UUID. */
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ConnectorSpec {
  sectionName: string
  name: string
  /** Cloud provider slug — one of aws | azure | gcp. */
  type: string
  /**
   * Raw JSON string of provider-specific params/credentials. These are SECRETS
   * (write-only in Tenable): they are re-sent on every deploy but never read
   * back, so they are not drift-checked and cannot be restored on rollback.
   */
  paramsJson?: string
  /** Optional target network UUID (create body field `network_uuid`). */
  networkUuid?: string
  /** Optional sync-interval value (paired with scheduleUnits). */
  scheduleValue?: number
  /** Optional sync-interval units — hours | days. */
  scheduleUnits?: string
}

/**
 * Shape of a connector returned by GET /settings/connectors and
 * GET /settings/connectors/{id}. Note the list echoes the network as
 * `network_id` even though the create body takes `network_uuid`, and `params`
 * are NEVER present on a read (write-only secrets).
 */
export interface LiveConnector {
  id?: string
  name?: string
  type?: string
  network_id?: string
  schedule?: {
    units?: string
    value?: number
  } | null
}

/** Coerce a number-field value to a finite number, or undefined when unset. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not
 * a JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseParamsObject(raw: string): Record<string, unknown> | null {
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

/** Each canvas item describes one Tenable cloud connector. */
export function extractConnectorSpecs(canvas: CanvasSnapshot): ConnectorSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const paramsJson =
      typeof fields.paramsJson === 'string' && fields.paramsJson.trim()
        ? fields.paramsJson.trim()
        : undefined
    const networkUuid =
      typeof fields.networkUuid === 'string' && fields.networkUuid.trim()
        ? fields.networkUuid.trim()
        : undefined
    const scheduleUnits =
      typeof fields.scheduleUnits === 'string' && fields.scheduleUnits.trim()
        ? fields.scheduleUnits.trim().toLowerCase()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '',
      paramsJson,
      networkUuid,
      scheduleValue: toNumber(fields.scheduleValue),
      scheduleUnits,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate connector configurations against Connectors API constraints:
 * a name (unique within the canvas), a provider type in the allowed enum,
 * a params JSON object (the write-only credentials), an optional network UUID,
 * and an optional sync schedule (value >= 1, units in the allowed enum). This
 * is static only — it never contacts Tenable and never inspects the SECRET
 * contents of params beyond confirming the blob parses as a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractConnectorSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required + unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Connector name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_CONNECTOR_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Connector name must be ${MAX_CONNECTOR_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate connector "${spec.name}" — each connector may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — required, and must be one of the supported cloud providers
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Cloud provider (type) is required', code: 'required' })
    } else if (!(CONNECTOR_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Cloud provider must be one of: ${CONNECTOR_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // paramsJson — required; must parse as a JSON object (its SECRET contents
    // are never inspected here, only that the blob is a well-formed object).
    if (!spec.paramsJson) {
      errors.push({
        field: `${prefix}.paramsJson`,
        message: 'Connector params (JSON credentials) are required',
        code: 'required',
      })
    } else if (parseParamsObject(spec.paramsJson) === null) {
      errors.push({
        field: `${prefix}.paramsJson`,
        message: 'Connector params must be a valid JSON object, e.g. {"access_key":"…","secret_key":"…"}',
        code: 'invalid_params',
      })
    }

    // networkUuid — optional; when present it must be a well-formed UUID
    if (spec.networkUuid && !UUID_PATTERN.test(spec.networkUuid)) {
      errors.push({
        field: `${prefix}.networkUuid`,
        message: 'Network UUID must be a valid UUID (e.g. 00000000-0000-0000-0000-000000000000)',
        code: 'invalid_network',
      })
    }

    // scheduleValue — optional; when present it must be a whole number >= 1
    if (
      spec.scheduleValue !== undefined &&
      (!Number.isInteger(spec.scheduleValue) || spec.scheduleValue < 1)
    ) {
      errors.push({
        field: `${prefix}.scheduleValue`,
        message: 'Sync interval must be a whole number of 1 or more',
        code: 'invalid_schedule_value',
      })
    }

    // scheduleUnits — optional; when present it must be in the allowed enum
    if (spec.scheduleUnits && !(SCHEDULE_UNITS as readonly string[]).includes(spec.scheduleUnits)) {
      errors.push({
        field: `${prefix}.scheduleUnits`,
        message: `Sync interval units must be one of: ${SCHEDULE_UNITS.join(', ')}`,
        code: 'invalid_schedule_units',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
