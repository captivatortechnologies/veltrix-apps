import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar QID record + DSM event mapping constraints -------------------
//
// A QID record is a normalized event definition; DSM event mappings point a
// device's (event id, category) to that QID. The API supports CREATE + UPDATE
// only (NO DELETE on either resource), so this type is APPEND/UPDATE-ONLY:
// deploy creates missing records/mappings and updates changed fields, but
// records/mappings this app creates can never be removed via the API.
//
// The log source type and low level category are declared by NAME and resolved
// to their numeric ids in deploy. A QID record's identity is (log source type,
// name); a mapping's identity is (log source type, event id, event category).

export interface EventMappingSpec {
  eventId: string
  eventCategory: string
}

export interface QidRecordSpec {
  itemId?: string
  logSourceType: string
  name: string
  description: string
  lowLevelCategory: string
  severity?: number
  mappingsRaw: string
}

/** A QID record as returned by GET /data_classification/qid_records. */
export interface LiveQidRecord {
  id?: number
  qid?: number
  name?: string
  description?: string
  severity?: number
  low_level_category_id?: number
  log_source_type_id?: number
}

/** A DSM event mapping as returned by GET /data_classification/dsm_event_mappings. */
export interface LiveEventMapping {
  id?: number
  log_source_type_id?: number
  log_source_event_id?: string
  log_source_event_category?: string
  qid_record_id?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

export function recordKey(logSourceType: string, name: string): string {
  return `${logSourceType.toLowerCase()} ${name.toLowerCase()}`
}

export function mappingKey(eventId: string, eventCategory: string): string {
  return `${eventId.toLowerCase()} ${eventCategory.toLowerCase()}`
}

export function parseMappings(raw: string): { mappings: EventMappingSpec[]; error?: string } {
  const text = raw.trim()
  if (!text) return { mappings: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { mappings: [], error: 'event mappings must be a JSON array of { "eventId", "eventCategory" }' }
  }
  if (!Array.isArray(parsed)) return { mappings: [], error: 'event mappings must be a JSON array' }
  const mappings: EventMappingSpec[] = []
  for (const m of parsed) {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    mappings.push({ eventId: asString(o.eventId), eventCategory: asString(o.eventCategory) })
  }
  return { mappings }
}

export function extractQidRecordSpecs(canvas: CanvasSnapshot): QidRecordSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const rawMappings =
      typeof f.eventMappings === 'string' ? f.eventMappings : f.eventMappings != null ? JSON.stringify(f.eventMappings) : ''
    return {
      itemId: item.id,
      logSourceType: asString(f.logSourceType),
      name: asString(f.name) || item.name,
      description: asString(f.description),
      lowLevelCategory: asString(f.lowLevelCategory),
      severity: asInt(f.severity),
      mappingsRaw: rawMappings,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractQidRecordSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.logSourceType) errors.push({ field: `${prefix}.logSourceType`, message: 'Log source type name is required', code: 'required' })
    if (!spec.name) errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    if (!spec.lowLevelCategory) errors.push({ field: `${prefix}.lowLevelCategory`, message: 'Low level category name is required', code: 'required' })

    if (spec.logSourceType && spec.name) {
      const key = recordKey(spec.logSourceType, spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate QID record "${spec.logSourceType}/${spec.name}"`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    if (spec.severity !== undefined && (spec.severity < 0 || spec.severity > 10)) {
      errors.push({ field: `${prefix}.severity`, message: 'Severity must be between 0 and 10', code: 'out_of_range' })
    }

    const { mappings, error } = parseMappings(spec.mappingsRaw)
    if (error) {
      errors.push({ field: `${prefix}.eventMappings`, message: error, code: 'invalid_event_mappings' })
    } else {
      const seenMap = new Set<string>()
      mappings.forEach((m, mi) => {
        if (!m.eventId) errors.push({ field: `${prefix}.eventMappings[${mi}].eventId`, message: 'Each mapping needs an event id', code: 'required' })
        if (!m.eventCategory) errors.push({ field: `${prefix}.eventMappings[${mi}].eventCategory`, message: 'Each mapping needs an event category', code: 'required' })
        const k = mappingKey(m.eventId, m.eventCategory)
        if (m.eventId && m.eventCategory && seenMap.has(k)) {
          errors.push({ field: `${prefix}.eventMappings[${mi}]`, message: `Duplicate event mapping "${m.eventId}/${m.eventCategory}"`, code: 'duplicate_mapping' })
        }
        seenMap.add(k)
      })
    }
  })

  if (specs.length > 0) {
    warnings.push({ field: 'items', message: 'QID records and event mappings are append/update-only: this app cannot remove ones it creates', code: 'append_only' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
