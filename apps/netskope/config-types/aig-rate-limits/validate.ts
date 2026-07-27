import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope AI Gateway rate-limit rule constraints -------------------------

export const MAX_NAME_LENGTH = 15
export const MAX_APPLIANCE_IDS = 5

export interface RateLimitSpec {
  itemId?: string
  /** name — the logical identity (rules are id-addressed; 1-15 chars). */
  name: string
  /** Match criteria and threshold managed as validated JSON objects. */
  criteriaRaw: string
  limitRaw: string
  applianceIds: string[]
  response: string
}

/** A rate-limit rule as returned by GET /api/v2/aig/ratelimits. */
export interface LiveRateLimit {
  id?: number | string
  rule_id?: number | string
  name?: string
  criteria?: Record<string, unknown>
  limit?: Record<string, unknown>
  appliance_ids?: Array<string | number>
  response?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Parse a required JSON-object field. */
export function parseJsonObject(v: unknown): { provided: boolean; value?: Record<string, unknown>; error?: string } {
  const raw = asString(v)
  if (!raw) return { provided: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { provided: true, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { provided: true, error: 'must be a JSON object' }
  }
  return { provided: true, value: parsed as Record<string, unknown> }
}

export function liveRateLimitId(l: LiveRateLimit): string | undefined {
  const v = l.id ?? l.rule_id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractRateLimitSpecs(canvas: CanvasSnapshot): RateLimitSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      criteriaRaw: asString(f.criteria),
      limitRaw: asString(f.limit),
      applianceIds: splitEntries(f.appliance_ids),
      response: asString(f.response),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRateLimitSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate rate-limit rule "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    for (const [field, raw] of [
      ['criteria', spec.criteriaRaw],
      ['limit', spec.limitRaw],
    ] as const) {
      const parsed = parseJsonObject(raw)
      if (!parsed.provided) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} is required (a JSON object)`, code: 'required' })
      } else if (parsed.error) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} is not valid JSON: ${parsed.error}`, code: 'invalid_json' })
      }
    }

    if (spec.applianceIds.length > MAX_APPLIANCE_IDS) {
      errors.push({ field: `${prefix}.appliance_ids`, message: `At most ${MAX_APPLIANCE_IDS} appliance ids are allowed`, code: 'too_many' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
