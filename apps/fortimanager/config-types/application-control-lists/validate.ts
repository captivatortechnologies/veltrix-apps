import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager application control profile constraints --------------------

export const MAX_NAME_LENGTH = 47
export const APP_ACTIONS = ['pass', 'block'] as const

export interface AppControlSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  comment: string
  /** pass | block */
  otherApplicationAction: string
  /** pass | block */
  unknownApplicationAction: string
  /** enable | disable */
  appReplacemsg: string
  /** enable | disable */
  deepAppInspection: string
  /** enable | disable */
  enforceDefaultAppPort: string
  /** Raw JSON for the entries list (validated to parse to an array). */
  entries: string
}

/** An application control profile as returned by a get on the application/list table. */
export interface LiveAppControl {
  name?: string
  comment?: string
  'other-application-action'?: string | number
  'unknown-application-action'?: string | number
  'app-replacemsg'?: string | number
  'deep-app-inspection'?: string | number
  'enforce-default-app-port'?: string | number
  entries?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asToggle(v: unknown, dflt: 'enable' | 'disable' = 'disable'): string {
  if (v === true || v === 'enable' || v === 'true') return 'enable'
  return dflt
}

export interface ParsedJson {
  ok: boolean
  value?: unknown
}

/** Parse a JSON textarea value. An empty value is valid (undefined). */
export function parseJsonField(raw: string): ParsedJson {
  const t = raw.trim()
  if (!t) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false }
  }
}

export function extractAppControlSpecs(canvas: CanvasSnapshot): AppControlSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comment: asString(f.comment),
      otherApplicationAction: (asString(f.otherApplicationAction) || 'pass').toLowerCase(),
      unknownApplicationAction: (asString(f.unknownApplicationAction) || 'pass').toLowerCase(),
      appReplacemsg: asToggle(f.appReplacemsg),
      deepAppInspection: asToggle(f.deepAppInspection),
      enforceDefaultAppPort: asToggle(f.enforceDefaultAppPort),
      entries: typeof f.entries === 'string' ? f.entries : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAppControlSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate application control profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(APP_ACTIONS as readonly string[]).includes(spec.otherApplicationAction)) {
      errors.push({ field: `${prefix}.otherApplicationAction`, message: `Action must be one of: ${APP_ACTIONS.join(', ')}`, code: 'invalid_action' })
    }
    if (!(APP_ACTIONS as readonly string[]).includes(spec.unknownApplicationAction)) {
      errors.push({ field: `${prefix}.unknownApplicationAction`, message: `Action must be one of: ${APP_ACTIONS.join(', ')}`, code: 'invalid_action' })
    }

    const parsed = parseJsonField(spec.entries)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.entries`, message: 'Entries must be valid JSON', code: 'invalid_json' })
    } else if (parsed.value !== undefined && !Array.isArray(parsed.value)) {
      errors.push({ field: `${prefix}.entries`, message: 'Entries must be a JSON array', code: 'invalid_json_shape' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
