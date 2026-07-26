import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { readBool, readKeyValueMap, readOptionalString, readString } from '../../lib/fields'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IntegrationInstanceSpec {
  sectionName: string
  /** The instance name — its logical identity (search + match). */
  name: string
  /** The integration brand/name this instance runs. */
  brand: string
  enabled: boolean
  /** Instance parameters (name → value) mapped onto the integration's config. */
  parameters: Record<string, string>
  /** Classifier applied to ingested incidents (the instance's mappingId). */
  mappingId?: string
  incomingMapperId?: string
  outgoingMapperId?: string
}

/** One parameter of an integration instance / configuration (from the API). */
export interface LiveIntegrationParam {
  name?: string
  display?: string
  value?: unknown
  hasvalue?: boolean
  /** XSOAR parameter type; 4 (secret) and 9 (encrypted/credentials) are masked. */
  type?: number
  defaultValue?: unknown
  required?: boolean
}

/** An integration instance returned by POST /settings/integration/search. */
export interface LiveIntegrationInstance {
  id?: string
  name?: string
  brand?: string
  /** XSOAR serializes the flag as the string "true"/"false". */
  enabled?: string | boolean
  data?: LiveIntegrationParam[]
  version?: number
  mappingId?: string
  incomingMapperId?: string
  outgoingMapperId?: string
  isIntegrationScript?: boolean
  [key: string]: unknown
}

/** An available integration (module configuration) from the search response. */
export interface LiveIntegrationConfiguration {
  id?: string
  /** The brand/name — matched against a spec's `brand`. */
  name?: string
  category?: string
  configuration?: LiveIntegrationParam[]
  defaultMapperIn?: string
  defaultClassifier?: string
  defaultMapperOut?: string
  [key: string]: unknown
}

/** The `{ instances, configurations }` envelope from /settings/integration/search. */
export interface IntegrationSearchResult {
  instances?: LiveIntegrationInstance[]
  configurations?: LiveIntegrationConfiguration[]
}

/** Parameter types XSOAR masks in read responses (secret / encrypted credentials). */
export const SECRET_PARAM_TYPES = new Set([4, 9])

/** True when a live instance is enabled (tolerates the string "true"/"false"). */
export function isInstanceEnabled(instance: LiveIntegrationInstance): boolean {
  return instance.enabled === true || instance.enabled === 'true'
}

/** Each canvas item describes one XSOAR integration instance. */
export function extractIntegrationInstanceSpecs(canvas: CanvasSnapshot): IntegrationInstanceSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.instanceName),
      brand: readString(fields.brand),
      enabled: readBool(fields.enabled, true),
      parameters: readKeyValueMap(fields.parameters),
      mappingId: readOptionalString(fields.mappingId),
      incomingMapperId: readOptionalString(fields.incomingMapperId),
      outgoingMapperId: readOptionalString(fields.outgoingMapperId),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate XSOAR integration-instance configurations: an instance name is
 * required and unique (its identity), an integration brand is required, and an
 * instance declaring no parameters is warned about (it is created with the
 * integration's default parameter values).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIntegrationInstanceSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.instanceName`, message: 'Integration instance name is required', code: 'required' })
      continue
    }

    if (seen.has(spec.name)) {
      errors.push({
        field: `${prefix}.instanceName`,
        message: `Duplicate integration instance "${spec.name}" — each instance name may only be declared once`,
        code: 'duplicate_instance',
      })
    }
    seen.add(spec.name)

    if (!spec.brand) {
      errors.push({
        field: `${prefix}.brand`,
        message: `Integration instance "${spec.name}" requires an integration (brand)`,
        code: 'brand_required',
      })
    }

    if (Object.keys(spec.parameters).length === 0) {
      warnings.push({
        field: `${prefix}.parameters`,
        message: `Instance "${spec.name}" declares no parameters — it will be created with the integration's default parameter values`,
        code: 'no_parameters',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
