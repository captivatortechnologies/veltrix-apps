import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Illumio Core Pairing Profile constraints ---------------------------------
// name: 1-255 chars (Terraform `nameValidation`). enforcement_mode: one of
// idle|visibility_only|full|selective (default visibility_only).
// visibility_level: one of flow_full_detail|flow_summary|flow_drops|flow_off|
// enhanced_data_collection. allowed_uses_per_key / key_lifespan: "unlimited"
// or an integer 1-2147483647 — confirmed via `isUnlimitedOrValidRange(1,
// 2147483647)`; the provider OMITS the field entirely (server default =
// unlimited) when the value isn't a parseable integer (`getInt(...)`, no
// fallback numeric sentinel). Confirmed against:
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_pairing_profile.go
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/pairing_profile.go

export const MAX_NAME_LENGTH = 255
export const ENFORCEMENT_MODES = ['idle', 'visibility_only', 'full', 'selective'] as const
export const VISIBILITY_LEVELS = ['flow_full_detail', 'flow_summary', 'flow_drops', 'flow_off', 'enhanced_data_collection'] as const
const MAX_LIMIT = 2147483647

export interface LabelRef {
  key: string
  value: string
}

export interface PairingProfileSpec {
  itemId?: string
  name: string
  description: string
  enabled: boolean
  enforcementMode: string
  enforcementModeLock: boolean
  /** "unlimited" or a positive integer as typed by the user. */
  allowedUsesPerKey: string
  /** "unlimited" or a positive integer (seconds) as typed by the user. */
  keyLifespan: string
  labels: LabelRef[]
  envLabelLock: boolean
  locLabelLock: boolean
  roleLabelLock: boolean
  appLabelLock: boolean
  logTraffic: boolean
  logTrafficLock: boolean
  /** Empty string means "not set" (optional field). */
  visibilityLevel: string
  visibilityLevelLock: boolean
  externalDataSet: string
  externalDataReference: string
  labelsError?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function parseLabelRefArray(raw: unknown): { value: LabelRef[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  const value: LabelRef[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    value.push({ key: asString(e.key), value: asString(e.value) })
  }
  return { value }
}

export function extractPairingProfileSpecs(canvas: CanvasSnapshot): PairingProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const labelsParsed = parseLabelRefArray(f.labelsJson)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      enabled: asBoolean(f.enabled, true),
      enforcementMode: asString(f.enforcementMode) || 'visibility_only',
      enforcementModeLock: asBoolean(f.enforcementModeLock, true),
      allowedUsesPerKey: asString(f.allowedUsesPerKey) || 'unlimited',
      keyLifespan: asString(f.keyLifespan) || 'unlimited',
      labels: labelsParsed.value,
      envLabelLock: asBoolean(f.envLabelLock, true),
      locLabelLock: asBoolean(f.locLabelLock, true),
      roleLabelLock: asBoolean(f.roleLabelLock, true),
      appLabelLock: asBoolean(f.appLabelLock, true),
      logTraffic: asBoolean(f.logTraffic, false),
      logTrafficLock: asBoolean(f.logTrafficLock, true),
      visibilityLevel: asString(f.visibilityLevel),
      visibilityLevelLock: asBoolean(f.visibilityLevelLock, true),
      externalDataSet: asString(f.externalDataSet),
      externalDataReference: asString(f.externalDataReference),
      labelsError: labelsParsed.error,
    }
  })
}

/** "unlimited" or an integer 1-2147483647. */
export function isUnlimitedOrValidRange(value: string): boolean {
  if (value === 'unlimited') return true
  if (!/^\d+$/.test(value)) return false
  const n = Number(value)
  return n >= 1 && n <= MAX_LIMIT
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPairingProfileSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate pairing profile "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(ENFORCEMENT_MODES as readonly string[]).includes(spec.enforcementMode)) {
      errors.push({ field: `${prefix}.enforcementMode`, message: `Enforcement mode must be one of: ${ENFORCEMENT_MODES.join(', ')}`, code: 'invalid_enforcement_mode' })
    }

    if (spec.visibilityLevel && !(VISIBILITY_LEVELS as readonly string[]).includes(spec.visibilityLevel)) {
      errors.push({ field: `${prefix}.visibilityLevel`, message: `Visibility level must be one of: ${VISIBILITY_LEVELS.join(', ')}`, code: 'invalid_visibility_level' })
    }

    if (!isUnlimitedOrValidRange(spec.allowedUsesPerKey)) {
      errors.push({ field: `${prefix}.allowedUsesPerKey`, message: 'Allowed uses per key must be "unlimited" or an integer from 1 to 2147483647', code: 'invalid_range' })
    }
    if (!isUnlimitedOrValidRange(spec.keyLifespan)) {
      errors.push({ field: `${prefix}.keyLifespan`, message: 'Key lifespan must be "unlimited" or an integer from 1 to 2147483647', code: 'invalid_range' })
    }

    if (spec.labelsError) {
      errors.push({ field: `${prefix}.labelsJson`, message: `Labels ${spec.labelsError}`, code: 'invalid_json' })
    } else {
      spec.labels.forEach((l, li) => {
        if (!l.key || !l.value) {
          errors.push({ field: `${prefix}.labelsJson[${li}]`, message: 'Each label ref needs both key and value', code: 'invalid_label_ref' })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
