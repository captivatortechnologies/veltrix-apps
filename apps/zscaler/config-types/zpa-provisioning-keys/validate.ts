import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZPA Provisioning Key constraints -----------------------------------------

/** ZPA caps a provisioning key name at 255 characters. */
export const MAX_KEY_NAME_LENGTH = 255

/**
 * The two association types a provisioning key can target. The value selects
 * both the CRUD path (`/associationType/{type}/provisioningKey`) and which
 * component group collection resolves `zcomponentId`:
 *   CONNECTOR_GRP    -> App Connector group  (/appConnectorGroup)
 *   SERVICE_EDGE_GRP -> Service Edge group   (/serviceEdgeGroup)
 */
export const ASSOCIATION_TYPES = ['CONNECTOR_GRP', 'SERVICE_EDGE_GRP'] as const
export type AssociationType = (typeof ASSOCIATION_TYPES)[number]

/** Default number of times a key may be used to enroll a component. */
export const DEFAULT_MAX_USAGE = 10

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ProvisioningKeySpec {
  sectionName: string
  /** The provisioning key name — its logical identity within the association type. */
  name: string
  /** CONNECTOR_GRP | SERVICE_EDGE_GRP — keeps the raw value so validate can flag bad input. */
  associationType: string
  /** How many enrollments the key allows; undefined when unset/non-numeric. */
  maxUsage?: number
  /** App Connector / Service Edge group NAME — resolved to zcomponentId at deploy. */
  componentGroupName: string
  /** Enrollment certificate NAME — resolved to enrollmentCertId at deploy. */
  enrollmentCertName: string
  enabled: boolean
}

/**
 * Shape of a provisioning key returned by
 * GET /associationType/{type}/provisioningKey.
 *
 * ⚠ The API response ALSO carries a `provisioningKey` field — the actual key
 * SECRET. It is deliberately NOT modelled here: the value is write-only and must
 * never be read back into drift, rollback state, artifacts or logs. Only the id
 * and the managed scalar settings are represented.
 */
export interface LiveProvisioningKey {
  id?: string
  name?: string
  /** ZPA returns maxUsage as a string. */
  maxUsage?: string | number
  enabled?: boolean
  /** Id of the App Connector / Service Edge group the key provisions into. */
  zcomponentId?: string
  /** Id of the enrollment certificate the key signs enrollments with. */
  enrollmentCertId?: string
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a text field as a trimmed string (numbers are stringified). */
export function readText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Read a numeric field; undefined when blank or non-numeric. */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Each canvas item describes one ZPA provisioning key. */
export function extractProvisioningKeySpecs(canvas: CanvasSnapshot): ProvisioningKeySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readText(fields.name),
      associationType: readText(fields.association_type),
      maxUsage: readNumber(fields.max_usage),
      componentGroupName: readText(fields.component_group_name),
      enrollmentCertName: readText(fields.enrollment_cert_name),
      enabled: readBool(fields.enabled, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate provisioning key configurations. Identity is the pair
 * (association_type, name) — a key name is unique WITHIN its association type, so
 * the same name may appear once under each type. name, association_type,
 * max_usage, component_group_name and enrollment_cert_name are all required;
 * association_type must be one of the two supported values and max_usage must be
 * a positive integer.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProvisioningKeySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Provisioning key name is required', code: 'required' })
    } else if (spec.name.length > MAX_KEY_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Provisioning key name must be ${MAX_KEY_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (!spec.associationType) {
      errors.push({
        field: `${prefix}.association_type`,
        message: 'Association type is required',
        code: 'required',
      })
    } else if (!(ASSOCIATION_TYPES as readonly string[]).includes(spec.associationType)) {
      errors.push({
        field: `${prefix}.association_type`,
        message: `Association type must be one of ${ASSOCIATION_TYPES.join(', ')}`,
        code: 'invalid_association_type',
      })
    }

    if (spec.maxUsage === undefined) {
      errors.push({ field: `${prefix}.max_usage`, message: 'Max usage is required', code: 'required' })
    } else if (!Number.isInteger(spec.maxUsage) || spec.maxUsage <= 0) {
      errors.push({
        field: `${prefix}.max_usage`,
        message: 'Max usage must be a positive integer',
        code: 'invalid_max_usage',
      })
    }

    if (!spec.componentGroupName) {
      errors.push({
        field: `${prefix}.component_group_name`,
        message: 'Component group name is required',
        code: 'required',
      })
    }

    if (!spec.enrollmentCertName) {
      errors.push({
        field: `${prefix}.enrollment_cert_name`,
        message: 'Enrollment certificate name is required',
        code: 'required',
      })
    }

    // Uniqueness is on (association_type, name) — the same name may live under
    // both association types (they are separate collections in ZPA).
    if (spec.name && spec.associationType) {
      const key = `${spec.associationType.toLowerCase()}|${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate provisioning key "${spec.name}" for association type ${spec.associationType} — each (association type, name) pair may only be declared once per canvas`,
          code: 'duplicate_provisioning_key',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
