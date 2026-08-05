import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud integration constraints ------------------------------------
// Prisma Cloud documents 15 integration types (POST/PUT /integrations,
// integrationConfig varies per type — see api-integration-config.md). 13 of
// them embed a real secret in integrationConfig (API key/token/password/
// private key, or a Terraform-provider-`Sensitive`-flagged externalId):
// slack, splunk, amazon_sqs, webhook, microsoft_teams, azure_service_bus_queue,
// jira, service_now, pager_duty, demisto, aws_s3, aws_sdl, snowflake.
//
// This config type is scoped to the only 2 types with ZERO embedded secret
// material: aws_security_hub (region list + AWS account id) and google_cscc
// (GCP org id + source id) — both are ordinary non-secret identifiers, not
// credentials. See README Coverage for the corrected reasoning on why the
// other 13 are deferred rather than modeled with this app's write-only
// `password` field type in this pass.

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

export const INTEGRATION_TYPES = ['aws_security_hub', 'google_cscc'] as const
export type IntegrationType = (typeof INTEGRATION_TYPES)[number]

export interface CloudRegion {
  name: string
  apiIdentifier: string
  cloudType?: string
  sdkId?: string
  enabled?: boolean
}

export interface IntegrationSpec {
  itemId?: string
  /** name — the identity (Prisma matches integrations by name). */
  name: string
  description: string
  integrationType: string
  enabled: boolean
  // aws_security_hub
  accountId: string
  regions: CloudRegion[]
  regionsError?: string
  defaultRegion: CloudRegion | null
  defaultRegionError?: string
  // google_cscc
  orgId: string
  sourceId: string
}

/** An integration as returned by GET /integrations. */
export interface LiveIntegration {
  id?: string
  name?: string
  description?: string | null
  enabled?: boolean
  integrationType?: string
  integrationConfig?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback
  return v === true || v === 'true'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRegion(v: unknown): v is CloudRegion {
  return isObject(v) && typeof v.name === 'string' && typeof v.apiIdentifier === 'string'
}

export function parseRegions(v: unknown): { regions: CloudRegion[]; error?: string } {
  if (v === null || v === undefined || v === '') return { regions: [] }
  let parsed: unknown = v
  if (typeof v === 'string') {
    try {
      parsed = JSON.parse(v)
    } catch {
      return { regions: [], error: 'Regions must be valid JSON' }
    }
  }
  if (!Array.isArray(parsed)) return { regions: [], error: 'Regions must be a JSON array of {name, apiIdentifier}' }
  if (!parsed.every(isRegion)) return { regions: [], error: 'Each region must be an object with "name" and "apiIdentifier"' }
  return { regions: parsed }
}

export function parseDefaultRegion(v: unknown): { defaultRegion: CloudRegion | null; error?: string } {
  if (v === null || v === undefined || v === '') return { defaultRegion: null }
  let parsed: unknown = v
  if (typeof v === 'string') {
    try {
      parsed = JSON.parse(v)
    } catch {
      return { defaultRegion: null, error: 'Default region must be valid JSON' }
    }
  }
  if (!isRegion(parsed)) return { defaultRegion: null, error: 'Default region must be an object with "name" and "apiIdentifier"' }
  return { defaultRegion: parsed }
}

export function extractIntegrationSpecs(canvas: CanvasSnapshot): IntegrationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { regions, error: regionsError } = parseRegions(f.regions)
    const { defaultRegion, error: defaultRegionError } = parseDefaultRegion(f.defaultRegion)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      integrationType: asString(f.integrationType),
      enabled: asBool(f.enabled, true),
      accountId: asString(f.accountId),
      regions,
      regionsError,
      defaultRegion,
      defaultRegionError,
      orgId: asString(f.orgId),
      sourceId: asString(f.sourceId),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIntegrationSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate integration "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.integrationType) {
      errors.push({ field: `${prefix}.integrationType`, message: 'Integration type is required', code: 'required' })
    } else if (!INTEGRATION_TYPES.includes(spec.integrationType as IntegrationType)) {
      errors.push({
        field: `${prefix}.integrationType`,
        message: `Integration type must be one of: ${INTEGRATION_TYPES.join(', ')} (the only 2 Prisma Cloud integration types with no embedded secret)`,
        code: 'invalid_type',
      })
    }

    if (spec.integrationType === 'aws_security_hub') {
      if (!spec.accountId) {
        errors.push({ field: `${prefix}.accountId`, message: 'AWS account id is required for aws_security_hub', code: 'required' })
      }
      if (spec.regionsError) {
        errors.push({ field: `${prefix}.regions`, message: spec.regionsError, code: 'invalid_regions' })
      } else if (spec.regions.length === 0) {
        errors.push({ field: `${prefix}.regions`, message: 'At least one region is required for aws_security_hub', code: 'required' })
      }
      if (spec.defaultRegionError) {
        errors.push({ field: `${prefix}.defaultRegion`, message: spec.defaultRegionError, code: 'invalid_default_region' })
      }
    }

    if (spec.integrationType === 'google_cscc') {
      if (!spec.orgId) {
        errors.push({ field: `${prefix}.orgId`, message: 'GCP org id is required for google_cscc', code: 'required' })
      }
      if (!spec.sourceId) {
        errors.push({ field: `${prefix}.sourceId`, message: 'GCP source id is required for google_cscc', code: 'required' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
