import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager web filter profile constraints -----------------------------
// Bounded scope: the top-level scalar toggles are first-class fields; the complex
// nested body (ftgd-wf category filters, web, override, antiphish, file-filter …)
// is supplied as one validated-JSON object.

export const MAX_NAME_LENGTH = 79

export interface WebFilterProfileSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  comment: string
  httpsReplacemsg: boolean
  logAllUrl: boolean
  webContentLog: boolean
  extendedLog: boolean
  wisp: boolean
  /** Raw JSON for the nested body (e.g. ftgd-wf). Validated to parse to an object. */
  bodyJson: string
}

/** A web filter profile as returned by a get on the webfilter/profile table. */
export interface LiveWebFilterProfile {
  name?: string
  comment?: string
  'https-replacemsg'?: string | number
  'log-all-url'?: string | number
  'web-content-log'?: string | number
  'extended-log'?: string | number
  wisp?: string | number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'enable' || v === 1
}

/** Parse the nested-body JSON. Empty is valid (an empty object). Non-object or
 *  malformed JSON is rejected so a bad blob never reaches the deploy body. */
export function parseBodyJson(raw: string): { ok: boolean; value: Record<string, unknown> } {
  if (!raw.trim()) return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> }
    }
    return { ok: false, value: {} }
  } catch {
    return { ok: false, value: {} }
  }
}

export function extractWebFilterProfileSpecs(canvas: CanvasSnapshot): WebFilterProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comment: asString(f.comment),
      httpsReplacemsg: asBool(f.httpsReplacemsg),
      logAllUrl: asBool(f.logAllUrl),
      webContentLog: asBool(f.webContentLog),
      extendedLog: asBool(f.extendedLog),
      wisp: asBool(f.wisp),
      bodyJson: typeof f.bodyJson === 'string' ? f.bodyJson : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractWebFilterProfileSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate web filter profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!parseBodyJson(spec.bodyJson).ok) {
      errors.push({ field: `${prefix}.bodyJson`, message: 'Advanced body must be valid JSON describing an object (e.g. {"ftgd-wf": {...}})', code: 'invalid_json' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
